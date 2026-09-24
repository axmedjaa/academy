import { randomBytes, createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { auditLogs, emailChangeTokens, users } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";

// Real Resend is never called from the test suite (Security requirement) —
// this mocks the one boundary lib/auth/email-change.ts sends through, so
// these tests verify recipient/subject/verify-URL content without any real
// network call, matching lib/email/client.test.ts's own boundary-mock style.
vi.mock("@/lib/email/client", () => ({ sendEmail: vi.fn() }));

import { sendEmail } from "@/lib/email/client";
import {
  applyEmailChangeToken,
  getPendingEmailChange,
  issueEmailChangeToken,
  resendEmailChangeVerification,
} from "./email-change";

const sendEmailMock = vi.mocked(sendEmail);

const createdUserIds: string[] = [];

async function createUser(): Promise<{ id: string; email: string }> {
  const email = `email-change-test-${randomUUID()}@example.com`;
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: await hashPassword("irrelevant-password-123456") })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return { id: user.id, email };
}

async function insertToken(
  userId: string,
  newEmail: string,
  overrides: { expiresAt?: Date; usedAt?: Date } = {},
): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(emailChangeTokens).values({
    userId,
    newEmail,
    tokenHash,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
    usedAt: overrides.usedAt,
  });
  return rawToken;
}

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ ok: true });
});

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.delete(auditLogs).where(eq(auditLogs.actorUserId, id));
    await db.delete(emailChangeTokens).where(eq(emailChangeTokens.userId, id));
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("issueEmailChangeToken", () => {
  it("creates an unused, unexpired token row for the pending new email", async () => {
    const user = await createUser();
    const newEmail = `pending-${randomUUID()}@example.com`;

    const result = await issueEmailChangeToken(user.id, newEmail);
    expect(result.ok).toBe(true);
    // Never returns the raw token to the caller.
    expect(result).not.toHaveProperty("token");

    const [row] = await db.select().from(emailChangeTokens).where(eq(emailChangeTokens.userId, user.id));
    expect(row.newEmail).toBe(newEmail);
    expect(row.usedAt).toBeNull();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("emails only the new address, with a verify link and never a bare 'token' field", async () => {
    const user = await createUser();
    const newEmail = `pending-${randomUUID()}@example.com`;

    await issueEmailChangeToken(user.id, newEmail);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe(newEmail);
    expect(call.subject).toBe("Verify your new email address");
    expect(call.html).toMatch(/\/account\/verify-email\?token=/);
  });

  it("invalidates a previously pending token when issuing a new one", async () => {
    const user = await createUser();
    await issueEmailChangeToken(user.id, `first-${randomUUID()}@example.com`);
    await issueEmailChangeToken(user.id, `second-${randomUUID()}@example.com`);

    const rows = await db.select().from(emailChangeTokens).where(eq(emailChangeTokens.userId, user.id));
    const unused = rows.filter((row) => row.usedAt === null);
    expect(unused.length).toBe(1);
    expect(unused[0].newEmail).toMatch(/^second-/);
  });

  it("returns a safe error and does not throw when email delivery fails", async () => {
    sendEmailMock.mockResolvedValue({ ok: false, error: "boom" });
    const user = await createUser();

    const result = await issueEmailChangeToken(user.id, `pending-${randomUUID()}@example.com`);
    expect(result.ok).toBe(false);

    // users.email is never touched by issuing alone, success or failure.
    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, user.id));
    expect(row.email).toBe(user.email);
  });
});

describe("applyEmailChangeToken", () => {
  it("rejects a token that doesn't exist", async () => {
    const result = await applyEmailChangeToken("not-a-real-token");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_or_used");
  });

  it("rejects an expired token without changing the email", async () => {
    const user = await createUser();
    const newEmail = `expired-${randomUUID()}@example.com`;
    const token = await insertToken(user.id, newEmail, { expiresAt: new Date(Date.now() - 1000) });

    const result = await applyEmailChangeToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("expired");

    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, user.id));
    expect(row.email).toBe(user.email);
  });

  it("rejects an already-used token", async () => {
    const user = await createUser();
    const token = await insertToken(user.id, `used-${randomUUID()}@example.com`, { usedAt: new Date() });

    const result = await applyEmailChangeToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_or_used");
  });

  it("rejects when the new email was claimed by another account in the meantime", async () => {
    const user = await createUser();
    const other = await createUser();
    const token = await insertToken(user.id, other.email);

    const result = await applyEmailChangeToken(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("email_taken");

    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, user.id));
    expect(row.email).toBe(user.email);
  });

  it("succeeds with a valid token: changes the email, marks the token used, and audits the change", async () => {
    const user = await createUser();
    const newEmail = `verified-${randomUUID()}@example.com`;
    const token = await insertToken(user.id, newEmail);

    const result = await applyEmailChangeToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.email).toBe(newEmail);

    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, user.id));
    expect(row.email).toBe(newEmail);

    const [tokenRow] = await db.select().from(emailChangeTokens).where(eq(emailChangeTokens.userId, user.id));
    expect(tokenRow.usedAt).not.toBeNull();

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, user.id));
    expect(audit.action).toBe("email_address_changed");
    expect(JSON.stringify(audit.before) + JSON.stringify(audit.after)).not.toMatch(/token/i);

    // Reusing the same (now-used) token must fail — no double-apply.
    const reuse = await applyEmailChangeToken(token);
    expect(reuse.ok).toBe(false);
  });

  it("verifying one user's token never changes a different user's email", async () => {
    const owner = await createUser();
    const bystander = await createUser();
    const newEmail = `owner-new-${randomUUID()}@example.com`;
    const token = await insertToken(owner.id, newEmail);

    await applyEmailChangeToken(token);

    const [bystanderRow] = await db.select({ email: users.email }).from(users).where(eq(users.id, bystander.id));
    expect(bystanderRow.email).toBe(bystander.email);
  });
});

describe("getPendingEmailChange", () => {
  it("returns null when there is no pending change", async () => {
    const user = await createUser();
    expect(await getPendingEmailChange(user.id)).toBeNull();
  });

  it("returns the pending new email while a token is outstanding", async () => {
    const user = await createUser();
    const newEmail = `pending-${randomUUID()}@example.com`;
    await issueEmailChangeToken(user.id, newEmail);

    const pending = await getPendingEmailChange(user.id);
    expect(pending?.newEmail).toBe(newEmail);
  });

  it("returns null once the token has expired", async () => {
    const user = await createUser();
    await insertToken(user.id, `expired-${randomUUID()}@example.com`, { expiresAt: new Date(Date.now() - 1000) });
    expect(await getPendingEmailChange(user.id)).toBeNull();
  });
});

describe("resendEmailChangeVerification", () => {
  it("errors when there is nothing pending to resend", async () => {
    const user = await createUser();
    const result = await resendEmailChangeVerification(user.id);
    expect(result.ok).toBe(false);
  });

  it("re-sends to the same pending address without requiring it to be re-entered", async () => {
    const user = await createUser();
    const newEmail = `pending-${randomUUID()}@example.com`;
    await issueEmailChangeToken(user.id, newEmail);
    sendEmailMock.mockClear();

    const result = await resendEmailChangeVerification(user.id);
    expect(result.ok).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].to).toBe(newEmail);
  });

  it("is rate-limited after repeated requests", async () => {
    const user = await createUser();
    const newEmail = `pending-${randomUUID()}@example.com`;
    await issueEmailChangeToken(user.id, newEmail);

    let sawRateLimited = false;
    for (let i = 0; i < 8; i += 1) {
      const result = await resendEmailChangeVerification(user.id);
      if (!result.ok && /too many/i.test(result.error)) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});
