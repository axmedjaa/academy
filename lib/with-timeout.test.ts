import { describe, expect, it } from "vitest";
import { TimeoutError, withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  it("resolves with the value when the promise settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 100, "op")).resolves.toBe(42);
  });

  it("passes through the original rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 100, "op")).rejects.toThrow("boom");
  });

  it("rejects with a TimeoutError naming the operation when the promise never settles", async () => {
    const started = Date.now();
    const error = await withTimeout(new Promise(() => undefined), 50, "redis add").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect((error as TimeoutError).message).toBe("redis add timed out after 50ms");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
