import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { recordAudit } from "./audit";

let insertedIds: string[] = [];

afterEach(async () => {
  for (const id of insertedIds) {
    await db.delete(auditLogs).where(eq(auditLogs.id, id));
  }
  insertedIds = [];
});

async function latestRowFor(entityType: string) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.entityType, entityType));
  insertedIds.push(...rows.map((r) => r.id));
  return rows[rows.length - 1];
}

describe("recordAudit", () => {
  it("inserts a row with only the required fields, defaulting result to success", async () => {
    await recordAudit({ action: "test.minimal", entityType: "test-minimal" });

    const row = await latestRowFor("test-minimal");
    expect(row).toBeDefined();
    expect(row.action).toBe("test.minimal");
    expect(row.result).toBe("success");
    expect(row.actorUserId).toBeNull();
    expect(row.academyId).toBeNull();
  });

  it("stores every optional field when provided", async () => {
    await recordAudit({
      action: "test.full",
      entityType: "test-full",
      entityId: "00000000-0000-0000-0000-000000000000",
      actorRole: "platform_owner",
      reason: "because",
      requestId: "req-123",
      result: "failure",
      failureReason: "it broke",
      ip: "203.0.113.1",
      userAgent: "vitest",
    });

    const row = await latestRowFor("test-full");
    expect(row.result).toBe("failure");
    expect(row.failureReason).toBe("it broke");
    expect(row.reason).toBe("because");
    expect(row.requestId).toBe("req-123");
    expect(row.actorRole).toBe("platform_owner");
  });

  it("redacts sensitive fields in before/after/context the same way the logger does", async () => {
    await recordAudit({
      action: "test.redaction",
      entityType: "test-redaction",
      before: { email: "user@example.com", password: "hunter2" },
      after: { email: "user@example.com", password_hash: "$argon2id$..." },
      context: { note: "kept", token: "raw-secret" },
    });

    const row = await latestRowFor("test-redaction");
    expect(row.before).toMatchObject({
      email: "user@example.com",
      password: "[REDACTED]",
    });
    expect(row.after).toMatchObject({ password_hash: "[REDACTED]" });
    expect(row.context).toMatchObject({ note: "kept", token: "[REDACTED]" });
  });

  it("participates in the caller's transaction: rolled back mutation leaves no audit row", async () => {
    await expect(
      db.transaction(async (tx) => {
        await recordAudit(
          { action: "test.rollback", entityType: "test-rollback" },
          tx,
        );
        throw new Error("simulated mutation failure");
      }),
    ).rejects.toThrow("simulated mutation failure");

    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityType, "test-rollback"));
    expect(rows.length).toBe(0);
  });

  it("commits when the caller's transaction succeeds", async () => {
    await db.transaction(async (tx) => {
      await recordAudit(
        { action: "test.commit", entityType: "test-commit" },
        tx,
      );
    });

    const row = await latestRowFor("test-commit");
    expect(row).toBeDefined();
  });
});
