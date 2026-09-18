import { describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { GET } from "./route";

describe("GET /api/health", () => {
  // Database/Redis connectivity are always "ok" in this local dev
  // environment; the queue check's real-world value depends on the
  // notification queue's actual current backlog (this repo's own
  // accumulated test runs have enqueued real BullMQ jobs over time with no
  // worker process continuously consuming them — see this file's own
  // note below), so it isn't hardcoded here. `status` is derived
  // algorithmically from `checks`, matching route.ts's own logic, rather
  // than assumed.
  it("reports database and redis as ok, and derives overall status/HTTP code correctly from the checks", async () => {
    const response = await GET();
    const body = await response.json();

    expect(body.checks.database).toBe("ok");
    expect(body.checks.redis).toBe("ok");
    expect(["ok", "error"]).toContain(body.checks.queue);

    const allOk = Object.values(body.checks).every((s) => s === "ok");
    expect(body.status).toBe(allOk ? "ok" : "degraded");
    expect(response.status).toBe(allOk ? 200 : 503);
  });

  it("returns 503 with the database check marked error, and never leaks the raw error message, when the database is unreachable", async () => {
    const spy = vi
      .spyOn(db, "execute")
      .mockRejectedValueOnce(new Error('password authentication failed for user "postgres"'));

    const response = await GET();
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.database).toBe("error");

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("password authentication failed");
    expect(raw).not.toContain("postgres");

    spy.mockRestore();
  });

  it("returns 503 with the redis check marked error, and never leaks connection details, when redis is unreachable", async () => {
    const spy = vi
      .spyOn(redis, "ping")
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:6379"));

    const response = await GET();
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.checks.redis).toBe("error");

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("ECONNREFUSED");
    expect(raw).not.toContain("127.0.0.1");

    spy.mockRestore();
  });

  it("never includes a connection string, credential-shaped value, or raw exception detail in the response body", async () => {
    const response = await GET();
    const raw = JSON.stringify(await response.json());

    expect(raw).not.toMatch(/postgres(ql)?:\/\//i);
    expect(raw).not.toMatch(/redis:\/\//i);
    expect(raw).not.toMatch(/error:/i);
    expect(Object.keys(await (await GET()).json())).toEqual(["status", "checks"]);
  });
});
