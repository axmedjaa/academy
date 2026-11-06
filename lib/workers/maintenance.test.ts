import { UnrecoverableError } from "bullmq";
import { describe, expect, it, vi } from "vitest";
import { EXPIRY_REMINDER_JOB_NAME } from "@/lib/subscriptions/expiry-reminder-job";
import { processMaintenanceJob } from "./maintenance";

describe("processMaintenanceJob", () => {
  it("runs the expiry scan for the scheduled job and returns its counts", async () => {
    const scan = vi.fn().mockResolvedValue({ scanned: 3, enqueued: 3, failed: 0 });
    await expect(processMaintenanceJob({ name: EXPIRY_REMINDER_JOB_NAME, id: "j1" }, { scanExpiringSubscriptions: scan })).resolves.toEqual({
      scanned: 3,
      enqueued: 3,
      failed: 0,
    });
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("rethrows when the scan cannot run, so BullMQ retries it", async () => {
    const scan = vi.fn().mockRejectedValue(new Error("database unreachable"));
    await expect(processMaintenanceJob({ name: EXPIRY_REMINDER_JOB_NAME }, { scanExpiringSubscriptions: scan })).rejects.toThrow("database unreachable");
  });

  it("fails an unknown job without retries", async () => {
    const scan = vi.fn();
    const error = await processMaintenanceJob({ name: "sendEmail" }, { scanExpiringSubscriptions: scan }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(scan).not.toHaveBeenCalled();
  });
});
