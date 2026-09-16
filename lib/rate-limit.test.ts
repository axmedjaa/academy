import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { redis } from "@/lib/redis";
import { checkRateLimit } from "./rate-limit";

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
