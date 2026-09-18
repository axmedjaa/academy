import { afterAll, describe, expect, it, vi } from "vitest";
import { notificationQueue } from "@/lib/notifications/queue";
import { runMonitoringSweep } from "./sweep";
import type { MonitoringSink } from "./monitor";

afterAll(async () => {
  await notificationQueue.close();
});

describe("runMonitoringSweep", () => {
  it("runs the real queue-health check plus every provider-health placeholder, and reports a summary event", async () => {
    const recordEvent = vi.fn();
    const sink: MonitoringSink = { recordEvent, recordMetric: vi.fn() };

    const result = await runMonitoringSweep(sink);

    expect(result.queue.queueName).toBeTruthy();
    expect(typeof result.queue.failedCount).toBe("number");
    expect(result.storage).toEqual({
      provider: "storage",
      status: "unknown",
      reason: expect.stringContaining("lib/storage"),
    });
    expect(result.email.status).toBe("unknown");
    expect(result.sms.status).toBe("unknown");

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "sweep.completed", level: "info" }),
    );
  });

  it("is callable with no arguments and defaults to the log sink", async () => {
    const result = await runMonitoringSweep();

    expect(result.queue).toBeDefined();
    expect(result.storage.status).toBe("unknown");
  });
});
