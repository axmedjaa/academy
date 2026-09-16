import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { academies, auditLogs, branches, users } from "@/lib/db/schema";
import {
  AUDIT_LOG_DEFAULT_PAGE_SIZE,
  AUDIT_LOG_MAX_PAGE_SIZE,
  fetchAuditLogs,
} from "./audit-query";

// Every row this suite writes carries this tag as its entityType so it can
// never collide with rows any other test (or real usage) writes, and every
// row gets cleaned up in afterAll regardless of which `it` wrote it.
const TAG = `audit-query-test-${randomUUID()}`;
const insertedAuditLogIds: string[] = [];
const insertedBranchIds: string[] = [];
const insertedAcademyIds: string[] = [];

let actorUserId: string;

async function insertRow(overrides: Partial<typeof auditLogs.$inferInsert> = {}) {
  const [row] = await db
    .insert(auditLogs)
    .values({
      action: "test.action",
      entityType: TAG,
      result: "success",
      ...overrides,
    })
    .returning({ id: auditLogs.id });
  insertedAuditLogIds.push(row.id);
  return row.id;
}

/**
 * academies.id and branches.id now carry real foreign keys from audit_logs
 * (Item 19 landed this concurrently with this task) — a bare randomUUID()
 * is no longer a valid academyId/branchId to insert, so tests that need one
 * for filter isolation create a real (throwaway) row instead.
 */
async function createAcademy(): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Audit query test academy ${randomUUID()}`,
      slug: `audit-query-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: actorUserId,
    })
    .returning({ id: academies.id });
  insertedAcademyIds.push(academy.id);
  return academy.id;
}

async function createBranch(academyId: string): Promise<string> {
  const [branch] = await db
    .insert(branches)
    .values({
      academyId,
      name: `Audit query test branch ${randomUUID()}`,
      code: `AQT-${randomUUID().slice(0, 8)}`,
    })
    .returning({ id: branches.id });
  insertedBranchIds.push(branch.id);
  return branch.id;
}

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({
      email: `audit-query-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  actorUserId = user.id;
});

afterAll(async () => {
  if (insertedAuditLogIds.length > 0) {
    await db.delete(auditLogs).where(inArray(auditLogs.id, insertedAuditLogIds));
  }
  if (insertedBranchIds.length > 0) {
    await db.delete(branches).where(inArray(branches.id, insertedBranchIds));
  }
  if (insertedAcademyIds.length > 0) {
    await db.delete(academies).where(inArray(academies.id, insertedAcademyIds));
  }
  await db.delete(users).where(eq(users.id, actorUserId));
});

describe("fetchAuditLogs", () => {
  it("filters by action", async () => {
    const uniqueAction = `test.action.${randomUUID()}`;
    await insertRow({ action: uniqueAction });
    await insertRow({ action: "test.other-action" });

    const result = await fetchAuditLogs({ action: uniqueAction });

    // uniqueAction is random per run, so exactly the one row above matches.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].action).toBe(uniqueAction);
  });

  it("filters by result", async () => {
    const academyId = await createAcademy();
    await insertRow({ academyId, result: "success" });
    await insertRow({ academyId, result: "failure" });

    const result = await fetchAuditLogs({ academyId, result: "failure" });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].result).toBe("failure");
  });

  it("filters by academyId", async () => {
    const academyId = await createAcademy();
    const otherAcademyId = await createAcademy();
    await insertRow({ academyId });
    await insertRow({ academyId });
    await insertRow({ academyId: otherAcademyId });

    const result = await fetchAuditLogs({ academyId });

    expect(result.totalCount).toBe(2);
    expect(result.rows.every((r) => r.academyId === academyId)).toBe(true);
  });

  it("filters by branchId", async () => {
    const academyId = await createAcademy();
    const branchId = await createBranch(academyId);
    const otherBranchId = await createBranch(academyId);
    await insertRow({ academyId, branchId });
    await insertRow({ academyId, branchId: otherBranchId });

    const result = await fetchAuditLogs({ academyId, branchId });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].branchId).toBe(branchId);
  });

  it("filters by actorUserId", async () => {
    const academyId = await createAcademy();
    await insertRow({ academyId, actorUserId });
    await insertRow({ academyId });

    const result = await fetchAuditLogs({ academyId, actorUserId });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].actorUserId).toBe(actorUserId);
  });

  it("filters by actorRole", async () => {
    const academyId = await createAcademy();
    await insertRow({ academyId, actorRole: "platform_owner" });
    await insertRow({ academyId, actorRole: "platform_admin" });

    const result = await fetchAuditLogs({ academyId, actorRole: "platform_admin" });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].actorRole).toBe("platform_admin");
  });

  it("filters by createdAt date range (inclusive bounds)", async () => {
    const academyId = await createAcademy();
    const early = new Date("2020-01-01T00:00:00.000Z");
    const middle = new Date("2020-06-01T00:00:00.000Z");
    const late = new Date("2020-12-01T00:00:00.000Z");
    await insertRow({ academyId, createdAt: early });
    await insertRow({ academyId, createdAt: middle });
    await insertRow({ academyId, createdAt: late });

    const result = await fetchAuditLogs({
      academyId,
      createdFrom: new Date("2020-02-01T00:00:00.000Z"),
      createdTo: new Date("2020-07-01T00:00:00.000Z"),
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].createdAt.toISOString()).toBe(middle.toISOString());
  });

  it("combines multiple filters with AND semantics", async () => {
    const academyId = await createAcademy();
    await insertRow({ academyId, result: "failure", actorRole: "platform_admin" });
    await insertRow({ academyId, result: "success", actorRole: "platform_admin" });
    await insertRow({ academyId, result: "failure", actorRole: "platform_owner" });

    const result = await fetchAuditLogs({
      academyId,
      result: "failure",
      actorRole: "platform_admin",
    });

    expect(result.rows).toHaveLength(1);
  });

  it("orders rows by createdAt descending", async () => {
    const academyId = await createAcademy();
    const oldest = new Date("2021-01-01T00:00:00.000Z");
    const middle = new Date("2021-01-02T00:00:00.000Z");
    const newest = new Date("2021-01-03T00:00:00.000Z");
    await insertRow({ academyId, createdAt: oldest });
    await insertRow({ academyId, createdAt: newest });
    await insertRow({ academyId, createdAt: middle });

    const result = await fetchAuditLogs({ academyId });

    expect(result.rows.map((r) => r.createdAt.toISOString())).toEqual([
      newest.toISOString(),
      middle.toISOString(),
      oldest.toISOString(),
    ]);
  });

  it("defaults to page 1 with the default page size", async () => {
    const academyId = await createAcademy();
    for (let i = 0; i < 3; i++) {
      await insertRow({ academyId });
    }

    const result = await fetchAuditLogs({ academyId });

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(AUDIT_LOG_DEFAULT_PAGE_SIZE);
    expect(result.totalCount).toBe(3);
  });

  it("paginates with offset semantics across two pages", async () => {
    const academyId = await createAcademy();
    for (let i = 0; i < 3; i++) {
      await insertRow({ academyId });
    }

    const page1 = await fetchAuditLogs({ academyId }, { page: 1, pageSize: 2 });
    const page2 = await fetchAuditLogs({ academyId }, { page: 2, pageSize: 2 });

    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(1);
    expect(page1.totalCount).toBe(3);
    expect(page2.totalCount).toBe(3);

    const page1Ids = page1.rows.map((r) => r.id);
    const page2Ids = page2.rows.map((r) => r.id);
    expect(page1Ids.some((id) => page2Ids.includes(id))).toBe(false);
  });

  it("clamps a requested page size above the maximum", async () => {
    const academyId = await createAcademy();
    await insertRow({ academyId });

    const result = await fetchAuditLogs(
      { academyId },
      { pageSize: AUDIT_LOG_MAX_PAGE_SIZE + 500 },
    );

    expect(result.pageSize).toBe(AUDIT_LOG_MAX_PAGE_SIZE);
  });

  it("clamps a page number below 1 up to 1", async () => {
    const academyId = await createAcademy();
    await insertRow({ academyId });

    const result = await fetchAuditLogs({ academyId }, { page: 0 });

    expect(result.page).toBe(1);
  });

  it("returns an empty result set for filters matching nothing", async () => {
    // A SELECT's WHERE clause isn't subject to the FK constraint, so a
    // never-inserted academyId is fine here — it just matches nothing.
    const result = await fetchAuditLogs({ academyId: randomUUID() });

    expect(result.rows).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });
});
