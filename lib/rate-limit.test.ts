import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/lib/redis";
import type { MonitoringEvent, MonitoringMetric, MonitoringSink } from "@/lib/monitoring/monitor";
import { checkRateLimit } from "./rate-limit";

function mockSink(): MonitoringSink & {
  recordEvent: ReturnType<typeof vi.fn<(event: MonitoringEvent) => void>>;
  recordMetric: ReturnType<typeof vi.fn<(metric: MonitoringMetric) => void>>;
} {
  return { recordEvent: vi.fn(), recordMetric: vi.fn() };
}

let testKey: string;

afterEach(async () => {
  await redis.del(`ratelimit:${testKey}`);
});

describe("checkRateLimit", () => {
  it("allows attempts up to the limit, then blocks", async () => {
    testKey = `test-${randomUUID()}`;

    for (let i = 1; i <= 3; i++) {
      const result = await checkRateLimit(testKey, {
        maxAttempts: 3,
        windowSeconds: 60,
      });
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(3 - i);
    }

    const blocked = await checkRateLimit(testKey, {
      maxAttempts: 3,
      windowSeconds: 60,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks separate keys independently", async () => {
    testKey = `test-${randomUUID()}`;
    const otherKey = `test-${randomUUID()}`;

    await checkRateLimit(testKey, { maxAttempts: 1, windowSeconds: 60 });
    const blockedOnFirst = await checkRateLimit(testKey, {
      maxAttempts: 1,
      windowSeconds: 60,
    });
    const allowedOnSecond = await checkRateLimit(otherKey, {
      maxAttempts: 1,
      windowSeconds: 60,
    });

    expect(blockedOnFirst.allowed).toBe(false);
    expect(allowedOnSecond.allowed).toBe(true);

    await redis.del(`ratelimit:${otherKey}`);
  });

  it("resets after the window expires", async () => {
    testKey = `test-${randomUUID()}`;

    await checkRateLimit(testKey, { maxAttempts: 1, windowSeconds: 1 });
    const blocked = await checkRateLimit(testKey, {
      maxAttempts: 1,
      windowSeconds: 1,
    });
    expect(blocked.allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const allowedAgain = await checkRateLimit(testKey, {
      maxAttempts: 1,
      windowSeconds: 1,
    });
    expect(allowedAgain.allowed).toBe(true);
  });
});

/**
 * Security regression tests (Priority 2 — "Redis rate-limit failure").
 * Simulates Redis being unreachable by making the real `redis` client's
 * own `incr` reject, the same way a real connection-refused or timeout
 * error surfaces to `checkRateLimit` — no second Redis instance needed to
 * exercise the exact catch path these tests assert on.
 */
describe("checkRateLimit — Redis outage policy", () => {
  // The consecutive-failure streak this policy tracks is module-level
  // state shared across every call in the process, by design (see
  // rate-limit.ts's own comment on why) — which means it's also shared
  // across tests in this file unless each one starts from a known state.
  // One real, unmocked call per test unconditionally resets the streak to
  // 0 (success always does), giving every test in this block a clean
  // starting point with no changes needed to the module itself.
  beforeEach(async () => {
    await checkRateLimit(`test-reset-${randomUUID()}`, { maxAttempts: 5, windowSeconds: 60 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails open on a connection-refused-style error (preserves legitimate access)", async () => {
    vi.spyOn(redis, "incr").mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:6379"), { code: "ECONNREFUSED" }),
    );
    const sink = mockSink();

    const result = await checkRateLimit(`test-${randomUUID()}`, { maxAttempts: 5, windowSeconds: 60 }, sink);

    expect(result.allowed).toBe(true);
    expect(sink.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "rate_limit.redis_unavailable",
        context: expect.objectContaining({ consecutiveFailures: 1, failingOpen: true }),
      }),
    );
  });

  it("fails open on a timeout-style error", async () => {
    vi.spyOn(redis, "incr").mockRejectedValueOnce(new Error("Command timed out"));
    const sink = mockSink();

    const result = await checkRateLimit(`test-${randomUUID()}`, { maxAttempts: 5, windowSeconds: 60 }, sink);

    expect(result.allowed).toBe(true);
  });

  it("escalates to an alert-level event only once failures are sustained across calls", async () => {
    const sink = mockSink();
    const failure = () => new Error("connect ECONNREFUSED");
    vi.spyOn(redis, "incr")
      .mockRejectedValueOnce(failure())
      .mockRejectedValueOnce(failure())
      .mockRejectedValueOnce(failure());

    // Same outage, three separate calls (as separate requests during a
    // real outage would be) — `checkThreshold` only emits its own
    // "alert"-level event once the streak crosses
    // SUSTAINED_OUTAGE_THRESHOLD (3); the first two calls stay below it.
    await checkRateLimit(`test-${randomUUID()}`, { maxAttempts: 5, windowSeconds: 60 }, sink);
    await checkRateLimit(`test-${randomUUID()}`, { maxAttempts: 5, windowSeconds: 60 }, sink);
    expect(sink.recordEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "rate_limit.redis_consecutive_failures" }),
    );

    await checkRateLimit(`test-${randomUUID()}`, { maxAttempts: 5, windowSeconds: 60 }, sink);
    expect(sink.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "rate_limit.redis_consecutive_failures",
        level: "alert",
        context: expect.objectContaining({ consecutiveFailures: 3 }),
      }),
    );

    // Every call (including the three above) also reports the quieter,
    // always-on "unavailable" event regardless of streak length.
    const unavailableCalls = sink.recordEvent.mock.calls.filter(
      ([event]) => event.name === "rate_limit.redis_unavailable",
    );
    expect(unavailableCalls).toHaveLength(3);
  });

  it("recovers immediately: a successful check after failures resets the streak", async () => {
    testKey = `test-${randomUUID()}`;
    const sink = mockSink();
    vi.spyOn(redis, "incr").mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const duringOutage = await checkRateLimit(testKey, { maxAttempts: 5, windowSeconds: 60 }, sink);
    expect(duringOutage.allowed).toBe(true);
    expect(sink.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ consecutiveFailures: 1 }) }),
    );

    // Redis is back — `incr` is no longer mocked to fail, so this call
    // hits the real connection and must behave like ordinary operation.
    const recovered = await checkRateLimit(testKey, { maxAttempts: 5, windowSeconds: 60 }, sink);
    expect(recovered.allowed).toBe(true);
    expect(recovered.remaining).toBe(4);

    // A brand-new failure right after recovery must be reported as
    // consecutiveFailures: 1 again, not a continuation of the old streak.
    vi.spyOn(redis, "incr").mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    sink.recordEvent.mockClear();
    await checkRateLimit(testKey, { maxAttempts: 5, windowSeconds: 60 }, sink);
    expect(sink.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ consecutiveFailures: 1 }) }),
    );
  });
});
