import { UnrecoverableError, Worker } from "bullmq";
import type Redis from "ioredis";
import { logger } from "@/lib/logger";
import { MAINTENANCE_QUEUE_NAME } from "@/lib/notifications/queue";
import {
  EXPIRY_REMINDER_JOB_NAME,
  scanForExpiringSubscriptions,
  type ExpiryReminderScanResult,
} from "@/lib/subscriptions/expiry-reminder-job";

/**
 * Scheduled maintenance jobs, processed by the worker process
 * (scripts/worker.ts) on the dedicated `maintenance` queue.
 *
 * The expiry scan itself already isolates per-subscription failures (each
 * is logged and counted, never thrown). A scan that cannot run at all
 * (e.g. database unreachable) is rethrown so BullMQ retries it
 * (EXPIRY_REMINDER_JOB_OPTIONS). An unknown job name is a programming error
 * and fails without retries.
 */

export interface MaintenanceDeps {
  scanExpiringSubscriptions: () => Promise<ExpiryReminderScanResult>;
}

const defaultDeps: MaintenanceDeps = { scanExpiringSubscriptions: () => scanForExpiringSubscriptions() };

export async function processMaintenanceJob(job: { name: string; id?: string }, deps: MaintenanceDeps = defaultDeps): Promise<unknown> {
  if (job.name === EXPIRY_REMINDER_JOB_NAME) {
    const result = await deps.scanExpiringSubscriptions();
    logger.info("maintenance.expiry_scan_completed", { jobId: job.id, ...result });
    return result;
  }
  throw new UnrecoverableError(`Unknown maintenance job: ${job.name}`);
}

/** One scan at a time; scans are short and idempotent. */
export function createMaintenanceWorker(connection: Redis): Worker {
  return new Worker(MAINTENANCE_QUEUE_NAME, (job) => processMaintenanceJob(job), {
    connection,
    concurrency: 1,
    lockDuration: 5 * 60_000,
  });
}
