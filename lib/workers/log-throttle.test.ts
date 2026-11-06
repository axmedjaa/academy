import { describe, expect, it } from "vitest";
import { createLogThrottle, errorSummary } from "./log-throttle";

describe("createLogThrottle", () => {
  it("lets the first line through, drops repeats inside the window, then reports how many were dropped", () => {
    let now = 0;
    const throttle = createLogThrottle(60_000, () => now);
    expect(throttle.admit("redis", "ECONNREFUSED")).toBe(0);
    now = 1_000;
    expect(throttle.admit("redis", "ECONNREFUSED")).toBeNull();
    expect(throttle.admit("redis", "ECONNREFUSED")).toBeNull();
    // A different message or key is not throttled by the first.
    expect(throttle.admit("redis", "ETIMEDOUT")).toBe(0);
    expect(throttle.admit("db", "ECONNREFUSED")).toBe(0);
    now = 61_000;
    expect(throttle.admit("redis", "ECONNREFUSED")).toBe(2);
  });
});

describe("errorSummary", () => {
  it("keeps only the first line and caps the length", () => {
    expect(errorSummary(new Error("first line\nsecond line"))).toBe("first line");
    expect(errorSummary(new Error("x".repeat(500)), 10)).toBe(`${"x".repeat(10)}…`);
  });

  it("replaces Drizzle's 'Failed query: <sql>' with the underlying cause", () => {
    const err = new Error('Failed query: select "id", "password_hash" from "users"\nparams: a@b.c', { cause: new Error("connect ECONNREFUSED 127.0.0.1:5432") });
    expect(errorSummary(err)).toBe("database query failed: connect ECONNREFUSED 127.0.0.1:5432");
  });
});
