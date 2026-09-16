import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";
import {
  createSession,
  generateSessionToken,
  hashSessionToken,
  listActiveSessionsForUser,
  revokeAllOtherSessionsForUser,
  revokeSession,
  revokeSessionForUser,
  sessionCookieOptions,
  validateSessionToken,
} from "./session";

let testUserId: string;
let otherUserId: string;

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({
      email: `session-test-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash-for-this-test",
    })
    .returning({ id: users.id });
  testUserId = user.id;

  const [other] = await db
    .insert(users)
    .values({
      email: `session-test-other-${randomUUID()}@example.com`,
      passwordHash: "not-a-real-hash-for-this-test",
    })
    .returning({ id: users.id });
  otherUserId = other.id;
});

afterAll(async () => {
  await db.delete(sessions).where(eq(sessions.userId, testUserId));
  await db.delete(sessions).where(eq(sessions.userId, otherUserId));
  await db.delete(users).where(eq(users.id, testUserId));
  await db.delete(users).where(eq(users.id, otherUserId));
});

describe("generateSessionToken / hashSessionToken", () => {
  it("generates a different token each time", () => {
    expect(generateSessionToken()).not.toBe(generateSessionToken());
  });

  it("hashes the same token to the same value deterministically", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("hashes different tokens to different values", () => {
    expect(hashSessionToken(generateSessionToken())).not.toBe(
      hashSessionToken(generateSessionToken()),
    );
  });
});

describe("createSession / validateSessionToken", () => {
  it("validates a freshly created session and returns its userId", async () => {
    const { token, session } = await createSession(testUserId, {
      ip: "203.0.113.1",
      userAgent: "vitest",
    });

    const result = await validateSessionToken(token);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(session.id);
    expect(result?.userId).toBe(testUserId);
  });

  it("rejects a nonexistent/tampered token", async () => {
    const result = await validateSessionToken(generateSessionToken());
    expect(result).toBeNull();
  });

  it("rejects an expired session", async () => {
    const { token, session } = await createSession(testUserId);
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, session.id));

    const result = await validateSessionToken(token);
    expect(result).toBeNull();
  });

  it("rejects a revoked session", async () => {
    const { token, session } = await createSession(testUserId);

    expect(await validateSessionToken(token)).not.toBeNull();

    await revokeSession(session.id);

    expect(await validateSessionToken(token)).toBeNull();
  });
});

describe("sessionCookieOptions", () => {
  it("is httpOnly, sameSite=lax, and not secure outside production", () => {
    const options = sessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.secure).toBe(false);
    expect(options.maxAge).toBeGreaterThan(0);
  });
});

describe("listActiveSessionsForUser", () => {
  it("lists only active (unrevoked, unexpired) sessions for the given user", async () => {
    const active = await createSession(testUserId, {
      ip: "203.0.113.5",
      userAgent: "vitest-active",
    });
    const revoked = await createSession(testUserId);
    await revokeSession(revoked.session.id);
    const expired = await createSession(testUserId);
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, expired.session.id));

    const list = await listActiveSessionsForUser(testUserId);
    const ids = list.map((s) => s.id);

    expect(ids).toContain(active.session.id);
    expect(ids).not.toContain(revoked.session.id);
    expect(ids).not.toContain(expired.session.id);
  });

  it("never returns another user's sessions", async () => {
    const mine = await createSession(testUserId);
    const theirs = await createSession(otherUserId);

    const list = await listActiveSessionsForUser(testUserId);
    const ids = list.map((s) => s.id);

    expect(ids).toContain(mine.session.id);
    expect(ids).not.toContain(theirs.session.id);
  });
});

describe("revokeSessionForUser", () => {
  it("revokes a session that belongs to the calling user", async () => {
    const { token, session } = await createSession(testUserId);

    const result = await revokeSessionForUser(testUserId, session.id);
    expect(result.ok).toBe(true);

    expect(await validateSessionToken(token)).toBeNull();
  });

  // PLAN.md: "revokeSession must verify the target session belongs to the
  // calling user before revoking — an explicit IDOR-class check with its
  // own test." This is that test.
  it("IDOR: refuses to revoke another user's session, and the session stays valid", async () => {
    const { token, session } = await createSession(otherUserId);

    const result = await revokeSessionForUser(testUserId, session.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }

    // The target session must be untouched — not just "the call failed."
    expect(await validateSessionToken(token)).not.toBeNull();
  });

  it("returns the same NOT_FOUND for a nonexistent session ID as for someone else's session", async () => {
    const nonexistentResult = await revokeSessionForUser(
      testUserId,
      "00000000-0000-0000-0000-000000000000",
    );
    const { session } = await createSession(otherUserId);
    const otherUsersResult = await revokeSessionForUser(testUserId, session.id);

    expect(nonexistentResult).toEqual(otherUsersResult);
  });
});

describe("revokeAllOtherSessionsForUser", () => {
  it("revokes every other session for the user but leaves the current one active", async () => {
    const current = await createSession(testUserId);
    const other1 = await createSession(testUserId);
    const other2 = await createSession(testUserId);

    await revokeAllOtherSessionsForUser(testUserId, current.session.id);

    expect(await validateSessionToken(current.token)).not.toBeNull();
    expect(await validateSessionToken(other1.token)).toBeNull();
    expect(await validateSessionToken(other2.token)).toBeNull();
  });

  it("never touches another user's sessions", async () => {
    const mine = await createSession(testUserId);
    const theirs = await createSession(otherUserId);

    await revokeAllOtherSessionsForUser(testUserId, mine.session.id);

    expect(await validateSessionToken(theirs.token)).not.toBeNull();
  });
});
