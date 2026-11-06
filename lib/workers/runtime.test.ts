import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Logger } from "@/lib/logger";
import { startWorkerRuntime, type WorkerLike, type WorkerRuntimeDeps } from "./runtime";

function fakeLogger(): Logger & { lines: { level: string; message: string; meta?: Record<string, unknown> }[] } {
  const lines: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  const at = (level: string) => (message: string, meta?: Record<string, unknown>) => void lines.push({ level, message, meta });
  const logger = { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), child: () => logger };
  return logger as never;
}

class FakeWorker {
  listeners = new Map<string, (...args: unknown[]) => void>();
  closed = 0;
  constructor(public readonly name: string, private readonly closeDelayMs = 0) {}
  on(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.set(event, listener);
    return this;
  }
  async close() {
    this.closed += 1;
    if (this.closeDelayMs) await new Promise((r) => setTimeout(r, this.closeDelayMs));
  }
}

type FakeDeps = Omit<WorkerRuntimeDeps, "registerSchedules" | "recover" | "closeResources" | "logger"> & {
  registerSchedules: Mock<() => Promise<void>>;
  recover: Mock<() => Promise<unknown>>;
  closeResources: Mock<() => Promise<void>>;
  logger: ReturnType<typeof fakeLogger>;
};

function baseDeps(overrides: Partial<FakeDeps> = {}): { deps: FakeDeps; workers: FakeWorker[] } {
  const workers = [new FakeWorker("notifications"), new FakeWorker("maintenance")];
  const deps: FakeDeps = {
    createWorkers: () => workers as unknown as WorkerLike[],
    registerSchedules: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    recover: vi.fn<() => Promise<unknown>>().mockResolvedValue({ found: 0, requeued: 0, stoppedEarly: false }),
    closeResources: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    recoveryIntervalMs: 1_000,
    scheduleRetryMs: 500,
    shutdownTimeoutMs: 5_000,
    logger: fakeLogger(),
    ...overrides,
  };
  return { deps, workers };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startWorkerRuntime", () => {
  it("starts both workers, registers schedules and runs a recovery pass at startup", async () => {
    const { deps } = baseDeps();
    const runtime = startWorkerRuntime(deps);
    await vi.waitFor(() => expect(deps.recover).toHaveBeenCalledTimes(1));
    expect(runtime.workers.map((w) => w.name)).toEqual(["notifications", "maintenance"]);
    expect(deps.registerSchedules).toHaveBeenCalledTimes(1);
    await runtime.shutdown("test");
  });

  it("repeats the recovery pass on its interval", async () => {
    vi.useFakeTimers();
    const { deps } = baseDeps();
    const runtime = startWorkerRuntime(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.recover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deps.recover).toHaveBeenCalledTimes(3);
    await runtime.shutdown("test");
  });

  it("retries schedule registration instead of crashing when Redis is not ready yet", async () => {
    vi.useFakeTimers();
    const registerSchedules = vi.fn().mockRejectedValueOnce(new Error("Connection is closed.")).mockResolvedValue(undefined);
    const { deps } = baseDeps({ registerSchedules });
    const runtime = startWorkerRuntime(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(registerSchedules).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(registerSchedules).toHaveBeenCalledTimes(2);
    expect(deps.logger.lines.some((l) => l.message === "worker.schedule_registration_failed")).toBe(true);
    expect(deps.logger.lines.some((l) => l.message === "worker.schedules_registered")).toBe(true);
    await runtime.shutdown("test");
  });

  it("keeps running when a recovery pass throws", async () => {
    vi.useFakeTimers();
    const recover = vi.fn().mockRejectedValueOnce(new Error("db down")).mockResolvedValue({});
    const { deps } = baseDeps({ recover });
    const runtime = startWorkerRuntime(deps);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(deps.logger.lines.some((l) => l.message === "worker.recovery_failed")).toBe(true);
    await runtime.shutdown("test");
  });

  it("shuts down once: closes every worker, then the shared resources, and stops the timers", async () => {
    vi.useFakeTimers();
    const { deps, workers } = baseDeps();
    const runtime = startWorkerRuntime(deps);
    await vi.advanceTimersByTimeAsync(0);
    const first = runtime.shutdown("SIGTERM");
    const second = runtime.shutdown("SIGINT");
    expect(second).toBe(first);
    await first;
    expect(workers.map((w) => w.closed)).toEqual([1, 1]);
    expect(deps.closeResources).toHaveBeenCalledTimes(1);
    const callsAtShutdown = deps.recover.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.recover.mock.calls.length).toBe(callsAtShutdown);
  });

  it("waits for in-flight jobs (worker close) before closing shared resources", async () => {
    const order: string[] = [];
    const slow = new FakeWorker("notifications", 50);
    const originalClose = slow.close.bind(slow);
    slow.close = async () => {
      await originalClose();
      order.push("worker closed");
    };
    const { deps } = baseDeps({
      createWorkers: () => [slow] as unknown as WorkerLike[],
      closeResources: vi.fn(async () => {
        order.push("resources closed");
      }),
    });
    await startWorkerRuntime(deps).shutdown("SIGTERM");
    expect(order).toEqual(["worker closed", "resources closed"]);
  });

  it("does not hang forever when a worker never finishes closing", async () => {
    vi.useFakeTimers();
    const stuck = new FakeWorker("notifications");
    stuck.close = () => new Promise<void>(() => undefined);
    const { deps } = baseDeps({ createWorkers: () => [stuck] as unknown as WorkerLike[], shutdownTimeoutMs: 2_000 });
    const runtime = startWorkerRuntime(deps);
    const done = runtime.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBeUndefined();
    expect(deps.logger.lines.some((l) => l.message === "worker.shutdown_timeout")).toBe(true);
  });

  it("logs worker errors with repeats throttled", async () => {
    const { deps, workers } = baseDeps();
    const runtime = startWorkerRuntime(deps);
    const onError = workers[0].listeners.get("error")!;
    for (let i = 0; i < 5; i += 1) onError(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    expect(deps.logger.lines.filter((l) => l.message === "worker.error")).toHaveLength(1);
    await runtime.shutdown("test");
  });
});
