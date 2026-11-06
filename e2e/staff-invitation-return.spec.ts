import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { academyMemberships, auditLogs, notifications, sessions, staffBranchAssignments, staffInvitations, staffProfiles, users } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { createStaff } from "@/lib/academies/staff";
import { captureInvitations } from "@/lib/testing/staff-invitation-helpers";
import { ACADEMY_A } from "./fixtures/constants";

/**
 * SEC-H-01 follow-up: an existing account opens an invitation while signed
 * out, signs in, and is returned to the invitation — which it must still
 * accept explicitly. Also: a tampered return destination is ignored, a wrong
 * account cannot accept, an expired invitation is unavailable.
 * Runs against the isolated e2e server and TEST database only.
 */

const PASSWORD = "e2e-invitee-password-123";
const createdUsers: string[] = [];
const createdInvitations: string[] = [];

async function ownerUserId(): Promise<string> {
  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, ACADEMY_A.ownerEmail)).limit(1);
  if (!owner) throw new Error("e2e owner fixture missing");
  return owner.id;
}

async function createInvitee(): Promise<{ id: string; email: string }> {
  const email = `e2e-invitee-${randomUUID()}@example.com`;
  const [user] = await db.insert(users).values({ email, passwordHash: await hashPassword(PASSWORD) }).returning({ id: users.id });
  createdUsers.push(user.id);
  return { id: user.id, email };
}

async function inviteFromAcademyA(email: string): Promise<{ token: string; invitationId: string }> {
  const mail = captureInvitations();
  const result = await createStaff({ userId: await ownerUserId(), branchIds: [], academyWide: false }, { email, fullName: "E2E Invitee", phone: "+1-555-0199", role: "trainer" }, { deliver: mail.deliver });
  if (!result.ok) throw new Error(`invite failed: ${result.error.message}`);
  createdInvitations.push(result.invitationId);
  return { token: mail.lastToken(), invitationId: result.invitationId };
}

async function signInOnLoginPage(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const invitationStatus = async (id: string) => (await db.select({ status: staffInvitations.status }).from(staffInvitations).where(eq(staffInvitations.id, id)))[0]?.status;

test.afterAll(async () => {
  const profiles = await db.select({ id: staffProfiles.id }).from(staffProfiles).where(inArray(staffProfiles.userId, createdUsers.length ? createdUsers : ["00000000-0000-0000-0000-000000000000"]));
  if (profiles.length) await db.delete(staffBranchAssignments).where(inArray(staffBranchAssignments.staffProfileId, profiles.map((p) => p.id)));
  if (createdUsers.length) {
    await db.delete(staffProfiles).where(inArray(staffProfiles.userId, createdUsers));
    await db.delete(academyMemberships).where(inArray(academyMemberships.userId, createdUsers));
  }
  if (createdInvitations.length) {
    await db.delete(auditLogs).where(inArray(auditLogs.entityId, createdInvitations));
    await db.delete(staffInvitations).where(inArray(staffInvitations.id, createdInvitations));
  }
  if (createdUsers.length) {
    // Signing in writes sessions (and may write a notification) for each user.
    await db.delete(sessions).where(inArray(sessions.userId, createdUsers));
    await db.delete(notifications).where(inArray(notifications.userId, createdUsers));
    await db.delete(auditLogs).where(inArray(auditLogs.actorUserId, createdUsers));
    await db.delete(users).where(inArray(users.id, createdUsers));
  }
});

test.describe("Staff invitation: return after sign-in", () => {
  // Each test signs in through the dev server; the first one also pays for
  // compiling the pages it visits.
  test.describe.configure({ timeout: 120_000 });

  test("signed out -> Sign in to accept -> login -> back on the invitation, not yet accepted -> Accept", async ({ page, context }) => {
    const invitee = await createInvitee();
    const { token, invitationId } = await inviteFromAcademyA(invitee.email);

    await page.goto(`/staff-invitation?token=${token}`);
    await page.getByRole("button", { name: "Sign in to accept" }).click();
    await page.waitForURL((url) => url.pathname === "/login");
    // The token is never in the login URL.
    expect(page.url()).not.toContain(token);
    const stored = (await context.cookies()).find((c) => c.name === "post_login_return");
    expect(stored).toMatchObject({ httpOnly: true, path: "/login", sameSite: "Lax" });
    expect(stored!.expires - Date.now() / 1000).toBeLessThanOrEqual(15 * 60 + 5);

    await signInOnLoginPage(page, invitee.email, PASSWORD);
    await page.waitForURL((url) => url.pathname === "/staff-invitation" && url.searchParams.get("token") === token, { timeout: 30_000 });
    // Used once, then deleted.
    expect((await context.cookies()).some((c) => c.name === "post_login_return")).toBe(false);
    await expect(page.getByRole("button", { name: "Accept invitation" })).toBeVisible();
    // The token is in this page's URL: it must not leak through Referer.
    const referrerPolicies = await page.locator('meta[name="referrer"]').evaluateAll((els) => els.map((el) => el.getAttribute("content")));
    expect(referrerPolicies.length).toBeGreaterThan(0);
    expect(new Set(referrerPolicies)).toEqual(new Set(["no-referrer"]));
    // Returning does not accept.
    expect(await invitationStatus(invitationId)).toBe("pending");

    await page.getByRole("button", { name: "Accept invitation" }).click();
    await page.waitForURL((url) => url.pathname === "/academy/dashboard", { timeout: 30_000 });
    expect(await invitationStatus(invitationId)).toBe("accepted");
    const [membership] = await db.select().from(academyMemberships).where(and(eq(academyMemberships.userId, invitee.id), eq(academyMemberships.status, "active")));
    expect(membership?.role).toBe("trainer");
  });

  for (const tampered of ["https://evil.example/academy", "//evil.example/academy", "/\\evil.example", "/login", "javascript:alert(1)"]) {
    test(`a tampered return destination is ignored: ${tampered}`, async ({ page, context, baseURL }) => {
      const invitee = await createInvitee();
      await context.addCookies([{ name: "post_login_return", value: encodeURIComponent(tampered), url: `${baseURL}/login` }]);
      await page.goto("/login");
      await signInOnLoginPage(page, invitee.email, PASSWORD);
      await page.waitForURL((url) => url.pathname === "/academy/dashboard", { timeout: 30_000 });
      expect(new URL(page.url()).origin).toBe(new URL(baseURL!).origin);
    });
  }

  test("returning as a different account shows the wrong-account message and offers no Accept", async ({ page }) => {
    const invitee = await createInvitee();
    const other = await createInvitee();
    const { token, invitationId } = await inviteFromAcademyA(invitee.email);

    await page.goto(`/staff-invitation?token=${token}`);
    await page.getByRole("button", { name: "Sign in to accept" }).click();
    await page.waitForURL((url) => url.pathname === "/login");
    await signInOnLoginPage(page, other.email, PASSWORD);
    await page.waitForURL((url) => url.pathname === "/staff-invitation", { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Different account" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept invitation" })).toHaveCount(0);
    expect(await invitationStatus(invitationId)).toBe("pending");
  });

  test("an invitation that expired before the return is shown as unavailable", async ({ page }) => {
    const invitee = await createInvitee();
    const { token, invitationId } = await inviteFromAcademyA(invitee.email);

    await page.goto(`/staff-invitation?token=${token}`);
    await page.getByRole("button", { name: "Sign in to accept" }).click();
    await page.waitForURL((url) => url.pathname === "/login");
    await db.update(staffInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(staffInvitations.id, invitationId));
    await signInOnLoginPage(page, invitee.email, PASSWORD);
    await page.waitForURL((url) => url.pathname === "/staff-invitation", { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
    expect(await invitationStatus(invitationId)).toBe("pending");
  });
});
