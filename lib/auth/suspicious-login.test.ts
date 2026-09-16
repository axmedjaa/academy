import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { auditLogs, sessions, users } from "@/lib/db/schema";
import { createSession } from "@/lib/auth/session";
import { checkSuspiciousLogin } from "./suspicious-login";

let userId: string;

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({
      email: `suspicious-login-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning({ id: users.id });
  userId = user.id;
});

afterEach(async () => {
  await db.delete(auditLogs).where(eq(auditLogs.entityId, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

async function suspiciousAuditRows() {
  return db
    .select()
    .from(auditLogs)
    .where(
      and(eq(auditLogs.entityId, userId), eq(auditLogs.action, "login.suspicious")),
    );
}

describe("checkSuspiciousLogin", () => {
  it("flags a first-ever login (no session history) and writes an audit row", async () => {
    const flagged = await checkSuspiciousLogin(userId, {
      ip: "203.0.113.1",
      userAgent: "curl/8.0",
    });
    expect(flagged).toBe(true);

    const rows = await suspiciousAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe("success");
    expect(rows[0].action).toBe("login.suspicious");
    expect(rows[0].actorUserId).toBe(userId);
    expect(rows[0].ip).toBe("203.0.113.1");
    expect(rows[0].userAgent).toBe("curl/8.0");
  });

  it("does not flag the exact same IP/user-agent combination seen before", async () => {
    await createSession(userId, { ip: "203.0.113.1", userAgent: "curl/8.0" });

    const flagged = await checkSuspiciousLogin(userId, {
      ip: "203.0.113.1",
      userAgent: "curl/8.0",
    });
    expect(flagged).toBe(false);
    expect(await suspiciousAuditRows()).toHaveLength(0);
  });

  it("flags a new IP with the same, previously-seen user-agent", async () => {
    await createSession(userId, { ip: "203.0.113.1", userAgent: "curl/8.0" });

    const flagged = await checkSuspiciousLogin(userId, {
      ip: "203.0.113.99",
      userAgent: "curl/8.0",
    });
    expect(flagged).toBe(true);
  });

  it("flags a new user-agent with the same, previously-seen IP", async () => {
    await createSession(userId, { ip: "203.0.113.1", userAgent: "curl/8.0" });

    const flagged = await checkSuspiciousLogin(userId, {
      ip: "203.0.113.1",
      userAgent: "Mozilla/5.0 (different browser)",
    });
    expect(flagged).toBe(true);
  });

  it("treats a missing user-agent consistently (not flagged on repeat, flagged if now present)", async () => {
    await createSession(userId, { ip: "203.0.113.1", userAgent: undefined });

    const sameAgain = await checkSuspiciousLogin(userId, {
      ip: "203.0.113.1",
      userAgent: undefined,
    });
    expect(sameAgain).toBe(false);

    const nowWithAgent = await checkSuspiciousLogin(userId, {
      ip: "203.0.113.1",
      userAgent: "curl/8.0",
    });
    expect(nowWithAgent).toBe(true);
  });

  it("never flags based on another user's session history", async () => {
    const [otherUser] = await db
      .insert(users)
      .values({ email: `suspicious-other-${randomUUID()}@example.com`, passwordHash: "x" })
      .returning({ id: users.id });

    await createSession(otherUser.id, { ip: "203.0.113.1", userAgent: "curl/8.0" });

    const flagged = await checkSuspiciousLogin(userId, {
      ip: "203.0.113.1",
      userAgent: "curl/8.0",
    });
    expect(flagged).toBe(true);

    await db.delete(sessions).where(eq(sessions.userId, otherUser.id));
    await db.delete(users).where(eq(users.id, otherUser.id));
  });

  it("stores the caller-provided actorRole on the audit row when given", async () => {
    await checkSuspiciousLogin(userId, {
      ip: "203.0.113.1",
      userAgent: "curl/8.0",
      actorRole: "platform_owner",
    });

    const rows = await suspiciousAuditRows();
    expect(rows[0].actorRole).toBe("platform_owner");
  });
});
