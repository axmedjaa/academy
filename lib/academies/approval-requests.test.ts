import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { academies, approvalRequests, users } from "@/lib/db/schema";
import {
  createApprovalRequest,
  decideApprovalRequest,
  listPendingApprovalRequests,
} from "./approval-requests";

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `approval-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createAcademy(creatorUserId: string): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({
      name: `Approval Test Academy ${randomUUID()}`,
      slug: `approval-test-${randomUUID()}`,
      defaultCurrency: "USD",
      createdBy: creatorUserId,
    })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

afterAll(async () => {
  for (const academyId of createdAcademyIds) {
    await db.delete(approvalRequests).where(eq(approvalRequests.academyId, academyId));
  }
  for (const academyId of createdAcademyIds) {
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("createApprovalRequest / decideApprovalRequest — happy path", () => {
  it("creates a pending request and approves it", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    const requester = await createUser();
    const decider = await createUser();

    const created = await createApprovalRequest(db, {
      academyId,
      entityType: "grade_configuration",
      entityId: randomUUID(),
      requestedBy: requester,
      reason: "Please review",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.request.status).toBe("pending");
    expect(created.request.decidedBy).toBeNull();
    expect(created.request.decidedAt).toBeNull();

    const decided = await decideApprovalRequest(db, created.request.id, {
      decidedBy: decider,
      status: "approved",
    });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(decided.request.status).toBe("approved");
    expect(decided.request.decidedBy).toBe(decider);
    expect(decided.request.decidedAt).not.toBeNull();
  });

  it("rejects a request with a reason", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    const requester = await createUser();
    const decider = await createUser();

    const created = await createApprovalRequest(db, {
      academyId,
      entityType: "result",
      entityId: randomUUID(),
      requestedBy: requester,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const decided = await decideApprovalRequest(db, created.request.id, {
      decidedBy: decider,
      status: "rejected",
    });
    expect(decided.ok).toBe(true);
    if (decided.ok) expect(decided.request.status).toBe("rejected");
  });
});

describe("self-approval rejection", () => {
  it("refuses when requestedBy === decidedBy, independent of entity type", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    const requester = await createUser();

    for (const entityType of ["result", "grade_configuration", "expense", "student_payment"] as const) {
      const created = await createApprovalRequest(db, {
        academyId,
        entityType,
        entityId: randomUUID(),
        requestedBy: requester,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) continue;

      const decided = await decideApprovalRequest(db, created.request.id, {
        decidedBy: requester,
        status: "approved",
      });
      expect(decided.ok).toBe(false);
      if (!decided.ok) expect(decided.error.code).toBe("self_approval");
    }
  });
});

describe("idempotency — a decided request cannot be decided again", () => {
  it("refuses a second decision on an already-approved request", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    const requester = await createUser();
    const decider = await createUser();
    const secondDecider = await createUser();

    const created = await createApprovalRequest(db, {
      academyId,
      entityType: "expense",
      entityId: randomUUID(),
      requestedBy: requester,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await decideApprovalRequest(db, created.request.id, {
      decidedBy: decider,
      status: "approved",
    });
    expect(first.ok).toBe(true);

    const second = await decideApprovalRequest(db, created.request.id, {
      decidedBy: secondDecider,
      status: "rejected",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("already_decided");

    // The original decision is untouched.
    const [row] = await db.select().from(approvalRequests).where(eq(approvalRequests.id, created.request.id));
    expect(row.status).toBe("approved");
    expect(row.decidedBy).toBe(decider);
  });
});

describe("decideApprovalRequest — not found", () => {
  it("returns 'not_found' for a nonexistent approval request id", async () => {
    const decider = await createUser();
    const result = await decideApprovalRequest(db, randomUUID(), { decidedBy: decider, status: "approved" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });
});

describe("listPendingApprovalRequests", () => {
  it("filters by academy and only returns 'pending' rows", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    const otherAcademyId = await createAcademy(creatorUserId);
    const requester = await createUser();
    const decider = await createUser();

    const pendingInAcademy = await createApprovalRequest(db, {
      academyId,
      entityType: "result",
      entityId: randomUUID(),
      requestedBy: requester,
    });
    const decidedInAcademy = await createApprovalRequest(db, {
      academyId,
      entityType: "result",
      entityId: randomUUID(),
      requestedBy: requester,
    });
    await createApprovalRequest(db, {
      academyId: otherAcademyId,
      entityType: "result",
      entityId: randomUUID(),
      requestedBy: requester,
    });

    expect(pendingInAcademy.ok).toBe(true);
    expect(decidedInAcademy.ok).toBe(true);
    if (!pendingInAcademy.ok || !decidedInAcademy.ok) return;

    await decideApprovalRequest(db, decidedInAcademy.request.id, { decidedBy: decider, status: "approved" });

    const pending = await listPendingApprovalRequests(academyId);
    expect(pending.map((r) => r.id)).toEqual([pendingInAcademy.request.id]);
  });

  it("filters by entity_type when provided", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    const requester = await createUser();

    const resultRequest = await createApprovalRequest(db, {
      academyId,
      entityType: "result",
      entityId: randomUUID(),
      requestedBy: requester,
    });
    const gradeRequest = await createApprovalRequest(db, {
      academyId,
      entityType: "grade_configuration",
      entityId: randomUUID(),
      requestedBy: requester,
    });
    expect(resultRequest.ok).toBe(true);
    expect(gradeRequest.ok).toBe(true);
    if (!resultRequest.ok || !gradeRequest.ok) return;

    const onlyGrade = await listPendingApprovalRequests(academyId, "grade_configuration");
    expect(onlyGrade.map((r) => r.id)).toEqual([gradeRequest.request.id]);

    const onlyResult = await listPendingApprovalRequests(academyId, "result");
    expect(onlyResult.map((r) => r.id)).toEqual([resultRequest.request.id]);
  });
});

describe("FK violations", () => {
  it("rejects a nonexistent academy_id", async () => {
    const requester = await createUser();
    await expect(
      db.insert(approvalRequests).values({
        academyId: randomUUID(),
        entityType: "result",
        entityId: randomUUID(),
        requestedBy: requester,
      }),
    ).rejects.toThrow();
  });

  it("rejects a nonexistent requested_by", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    await expect(
      db.insert(approvalRequests).values({
        academyId,
        entityType: "result",
        entityId: randomUUID(),
        requestedBy: randomUUID(),
      }),
    ).rejects.toThrow();
  });

  it("rejects a nonexistent decided_by", async () => {
    const creatorUserId = await createUser();
    const academyId = await createAcademy(creatorUserId);
    const requester = await createUser();
    await expect(
      db.insert(approvalRequests).values({
        academyId,
        entityType: "result",
        entityId: randomUUID(),
        requestedBy: requester,
        decidedBy: randomUUID(),
        status: "approved",
        decidedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
