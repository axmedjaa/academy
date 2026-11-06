import { describe, expect, it, vi } from "vitest";
import { GET as liveGET } from "@/app/api/health/live/route";
import { readinessReport, readinessResponse } from "./readiness";

const ok = () => Promise.resolve();
const fail = () => Promise.reject(new Error("password authentication failed for user admin at db.internal:5432"));
const hang = () => new Promise(() => undefined);

describe("GET /api/health/live", () => {
  it("answers 200 without touching any dependency", async () => {
    const response = liveGET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("readiness", () => {
  it("is ready (200) when the database answers", async () => {
    const report = await readinessReport({ pingDatabase: ok, pingRedis: ok, timeoutMs: 100 });
    const response = readinessResponse(report);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", checks: { database: "ok", redis: "ok" } });
  });

  it("is not ready (503) when the database fails, without leaking the error", async () => {
    const response = readinessResponse(await readinessReport({ pingDatabase: fail, pingRedis: ok, timeoutMs: 100 }));
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: "not_ready", checks: { database: "error", redis: "ok" } });
    expect(body).not.toContain("password");
    expect(body).not.toContain("db.internal");
  });

  it("is not ready when the database hangs — bounded by the check timeout", async () => {
    const started = Date.now();
    const report = await readinessReport({ pingDatabase: hang, pingRedis: ok, timeoutMs: 100 });
    expect(report.ready).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("stays ready when only Redis is down (degraded, reported, not required)", async () => {
    const pingRedis = vi.fn(fail);
    const report = await readinessReport({ pingDatabase: ok, pingRedis, timeoutMs: 100 });
    expect(report).toEqual({ ready: true, checks: { database: "ok", redis: "error" } });
    expect(readinessResponse(report).status).toBe(200);
  });

  it("stays bounded when Redis hangs", async () => {
    const started = Date.now();
    const report = await readinessReport({ pingDatabase: ok, pingRedis: hang, timeoutMs: 100 });
    expect(report.checks.redis).toBe("error");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
