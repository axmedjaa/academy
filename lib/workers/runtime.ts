import { logger as defaultLogger, type Logger } from "@/lib/logger";
import { createLogThrottle, errorSummary } from "@/lib/workers/log-throttle";

/**
 * Worker-process lifecycle (scripts/worker.ts), kept free of BullMQ/Redis
 * specifics so it can be tested with fakes:
 *
 * - starts the BullMQ workers and wires their events to the logger;
 * - registers recurring schedules, retrying on failure instead of crashing
 *   (Redis may still be starting);
 * - runs the notification recovery pass at startup and on an interval;
 * - shuts down gracefully once: stops timers, lets in-flight jobs finish
 *   (`Worker#close()` waits for active jobs), then closes queues, Redis and
 *   the database pool. A hard deadline guards against a hung close.
 */

export interface WorkerLike {
  readonly name: string;
  on(event: "failed", listener: (job: { id?: string; name: string; attemptsMade: number } | undefined, error: Error) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "stalled", listener: (jobId: string) => void): unknown;
  close(): Promise<void>;
}

export interface WorkerRuntimeDeps {
  createWorkers: () => WorkerLike[];
  registerSchedules: () => Promise<void>;
  recover: () => Promise<unknown>;
  /** Closes queues, Redis connections and the database pool. */
  closeResources: () => Promise<void>;
  recoveryIntervalMs: number;
  scheduleRetryMs: number;
  shutdownTimeoutMs: number;
  logger?: Logger;
}

export interface WorkerRuntime {
  readonly workers: WorkerLike[];
  /** Resolves once everything is closed. Safe to call more than once. */
  shutdown(reason: string): Promise<void>;
}

export function startWorkerRuntime(deps: WorkerRuntimeDeps): WorkerRuntime {
  const log = deps.logger ?? defaultLogger;
  const workers = deps.createWorkers();
  let stopping = false;
  let shutdownPromise: Promise<void> | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // Connection errors repeat on every reconnect attempt during an outage.
  const throttle = createLogThrottle(60_000);

  for (const worker of workers) {
    worker.on("failed", (job, error) => {
      log.warn("worker.job_failed", { queue: worker.name, jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, error: errorSummary(error) });
    });
    worker.on("error", (error) => {
      const suppressed = throttle.admit(`error:${worker.name}`, error.message);
      if (suppressed === null) return;
      log.error("worker.error", { queue: worker.name, error: errorSummary(error), ...(suppressed ? { repeatsSuppressed: suppressed } : {}) });
    });
    worker.on("stalled", (jobId) => {
      log.warn("worker.job_stalled", { queue: worker.name, jobId });
    });
  }

  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    timers.add(timer);
  };

  const registerSchedules = async (): Promise<void> => {
    if (stopping) return;
    try {
      await deps.registerSchedules();
      log.info("worker.schedules_registered");
    } catch (err) {
      log.warn("worker.schedule_registration_failed", { error: errorSummary(err), retryInMs: deps.scheduleRetryMs });
      later(() => void registerSchedules(), deps.scheduleRetryMs);
    }
  };

  const recover = async (): Promise<void> => {
    if (stopping) return;
    try {
      await deps.recover();
    } catch (err) {
      log.warn("worker.recovery_failed", { error: errorSummary(err) });
    }
    if (!stopping) later(() => void recover(), deps.recoveryIntervalMs);
  };

  void registerSchedules();
  void recover();
  log.info("worker.started", { queues: workers.map((w) => w.name) });

  return {
    workers,
    shutdown(reason: string): Promise<void> {
      if (shutdownPromise) return shutdownPromise;
      stopping = true;
      log.info("worker.shutting_down", { reason });
      for (const timer of timers) clearTimeout(timer);
      timers.clear();

      const work = (async () => {
        const results = await Promise.allSettled(workers.map((w) => w.close()));
        for (const [i, r] of results.entries()) {
          if (r.status === "rejected") log.error("worker.close_failed", { queue: workers[i].name, error: String(r.reason) });
        }
        await deps.closeResources();
      })();

      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        deadline = setTimeout(() => {
          log.error("worker.shutdown_timeout", { timeoutMs: deps.shutdownTimeoutMs });
          resolve();
        }, deps.shutdownTimeoutMs);
        deadline.unref?.();
      });

      shutdownPromise = Promise.race([work, timeout])
        .catch((err) => log.error("worker.shutdown_error", { error: err instanceof Error ? err.message : String(err) }))
        .finally(() => {
          if (deadline) clearTimeout(deadline);
          log.info("worker.stopped", { reason });
        });
      return shutdownPromise;
    },
  };
}
