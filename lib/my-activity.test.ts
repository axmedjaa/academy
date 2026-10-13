import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { auditLogs, users } from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth/auth-context";
import { getMyActivity, type MyActivityFilters } from "./my-activity";

// Same "unique entityType tag, one top-level cleanup" convention as
// lib/audit-query.test.ts.
const TAG = `my-activity-test-${randomUUID()}`;
const insertedAuditLogIds: string[] = [];
const insertedUserIds: string[] = [];

let userAId: string;
let userBId: string;
let contextA: AuthContext;
let contextB: AuthContext;

async function insertRow(actorUserId: string, overrides: Partial<typeof auditLogs.$inferInsert> = {}) {
  const [row] = await db
    .insert(auditLogs)
    .values({
      actorUserId,
      action: "test.action",
      entityType: TAG,
      result: "success",
      ...overrides,
    })
    .returning({ id: auditLogs.id });
  insertedAuditLogIds.push(row.id);
  return row.id;
}

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({
      email: `my-activity-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  insertedUserIds.push(user.id);
  return user.id;
}

beforeAll(async () => {
  userAId = await createUser();
  userBId = await createUser();
  contextA = { userId: userAId, branchIds: [], academyWide: false };
  contextB = { userId: userBId, branchIds: [], academyWide: false };
});

afterAll(async () => {
  if (insertedAuditLogIds.length > 0) {
    await db.delete(auditLogs).where(inArray(auditLogs.id, insertedAuditLogIds));
  }
  // Catches any row an action under test wrote itself (e.g. via recordAudit)
  // rather than through this suite's own insertRow helper.
  await db.delete(auditLogs).where(inArray(auditLogs.actorUserId, [userAId, userBId]));
  await db.delete(users).where(inArray(users.id, insertedUserIds));
});

describe("getMyActivity", () => {
  it("returns only the caller's own rows, never another user's", async () => {
    await insertRow(userAId, { action: `a.${TAG}` });
    await insertRow(userBId, { action: `b.${TAG}` });

    const result = await getMyActivity(contextA);

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.actorUserId === userAId)).toBe(true);
    expect(result.rows.some((row) => row.actorUserId === userBId)).toBe(false);
  });

  it("User B querying their own activity never sees User A's rows", async () => {
    await insertRow(userAId, { action: `a2.${TAG}` });
    await insertRow(userBId, { action: `b2.${TAG}` });

    const result = await getMyActivity(contextB);

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.actorUserId === userBId)).toBe(true);
    expect(result.rows.some((row) => row.actorUserId === userAId)).toBe(false);
  });

  it("ignores a malicious/different actorUserId smuggled into the filters object", async () => {
    await insertRow(userAId, { action: `a3.${TAG}` });
    await insertRow(userBId, { action: `b3.${TAG}` });

    // MyActivityFilters has no `actorUserId` field at the type level, but
    // this simulates a caller bypassing that (a hand-built object cast past
    // TypeScript, or a future refactor accidentally widening the type) —
    // the function must still hard-scope to the caller's own userId rather
    // than trust anything resembling a client-supplied actorUserId.
    const maliciousFilters = { actorUserId: userBId } as Record<string, unknown>;

    const result = await getMyActivity(contextA, maliciousFilters as MyActivityFilters);

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.actorUserId === userAId)).toBe(true);
    expect(result.rows.some((row) => row.actorUserId === userBId)).toBe(false);
  });

  it("combines the caller's own scoping with an action filter", async () => {
    const uniqueAction = `unique.${TAG}.${randomUUID()}`;
    await insertRow(userAId, { action: uniqueAction });
    await insertRow(userAId, { action: `other.${TAG}` });
    await insertRow(userBId, { action: uniqueAction });

    const result = await getMyActivity(contextA, { action: uniqueAction });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].actorUserId).toBe(userAId);
    expect(result.rows[0].action).toBe(uniqueAction);
  });

  it("combines the caller's own scoping with a result filter", async () => {
    await insertRow(userAId, { action: `s.${TAG}`, result: "success" });
    await insertRow(userAId, { action: `f.${TAG}`, result: "failure" });
    await insertRow(userBId, { action: `f.${TAG}`, result: "failure" });

    const result = await getMyActivity(contextA, { result: "failure" });

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.actorUserId === userAId)).toBe(true);
    expect(result.rows.every((row) => row.result === "failure")).toBe(true);
  });

  it("paginates the caller's own rows with offset semantics", async () => {
    const pageTag = `page.${TAG}.${randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      await insertRow(userAId, { action: pageTag });
    }
    await insertRow(userBId, { action: pageTag });

    const page1 = await getMyActivity(contextA, { action: pageTag }, { page: 1, pageSize: 2 });
    const page2 = await getMyActivity(contextA, { action: pageTag }, { page: 2, pageSize: 2 });

    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(1);
    expect(page1.totalCount).toBe(3);
    expect(page1.rows.every((row) => row.actorUserId === userAId)).toBe(true);
    expect(page2.rows.every((row) => row.actorUserId === userAId)).toBe(true);
  });

  it("returns an empty result for a user with no recorded activity", async () => {
    const lonelyUserId = await createUser();
    const lonelyContext: AuthContext = { userId: lonelyUserId, branchIds: [], academyWide: false };

    const result = await getMyActivity(lonelyContext);

    expect(result.rows).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });
});
