/**
 * Production worker entry point (deployment readiness Step 2).
 *
 * One process, one instance (do not run replicas yet): consumes the
 * `notifications` queue (email delivery; SMS is recorded as unsupported)
 * and the `maintenance` queue (daily subscription-expiry scan), re-queues
 * notifications that could not be queued while Redis was down, and shuts
 * down gracefully on SIGTERM/SIGINT.
 *
 * Configuration is the application's own (lib/env.ts), read from the
 * process environment. It never runs database migrations and starts no
 * HTTP server.
 *
 *   Development: npm run worker          (tsx + .env.local)
 *   Production:  npm run build:worker && npm run start:worker
 */
import type Redis from "ioredis";
import { closeDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { createNotificationWorker } from "@/lib/notifications/worker";
import { closeQueueProducers, createWorkerRedisConnection } from "@/lib/notifications/queue";
import { requeuePendingNotifications } from "@/lib/notifications/recovery";
import { redis as rateLimitRedis } from "@/lib/redis";
import { registerExpiryReminderRepeatableJob, removeLegacyExpiryReminderSchedule } from "@/lib/subscriptions/expiry-reminder-job";
import { createMaintenanceWorker } from "@/lib/workers/maintenance";
import { startWorkerRuntime, type WorkerLike } from "@/lib/workers/runtime";

const connections: Redis[] = [];

function workerConnection(): Redis {
  const connection = createWorkerRedisConnection();
  connections.push(connection);
  return connection;
}

const runtime = startWorkerRuntime({
  createWorkers: () => [
    createNotificationWorker(workerConnection()) as unknown as WorkerLike,
    createMaintenanceWorker(workerConnection()) as unknown as WorkerLike,
  ],
  registerSchedules: async () => {
    await removeLegacyExpiryReminderSchedule();
    await registerExpiryReminderRepeatableJob();
  },
  recover: () => requeuePendingNotifications(),
  closeResources: async () => {
    await closeQueueProducers();
    await Promise.allSettled(connections.map((c) => c.quit()));
    rateLimitRedis.disconnect();
    await closeDb();
  },
  recoveryIntervalMs: 5 * 60_000,
  scheduleRetryMs: 30_000,
  shutdownTimeoutMs: 30_000,
});

function stop(signal: NodeJS.Signals): void {
  runtime.shutdown(signal).finally(() => process.exit(0));
}

process.once("SIGTERM", stop);
process.once("SIGINT", stop);

process.on("unhandledRejection", (reason) => {
  logger.error("worker.unhandled_rejection", { error: reason instanceof Error ? reason.message : String(reason) });
});
process.on("uncaughtException", (err) => {
  logger.error("worker.uncaught_exception", { error: err.message });
  runtime.shutdown("uncaughtException").finally(() => process.exit(1));
});
