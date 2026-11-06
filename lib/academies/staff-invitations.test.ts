/**
 * SEC-H-01 regression suite (SECURITY_AUDIT_PRE_DEPLOYMENT.md): staff are
 * added by invitation, and only the owner of the invited email — signed in as
 * that account, or creating it with their own password — can turn an
 * invitation into access. Runs against TEST_DATABASE_URL only and removes
 * every row it creates.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  branches,
  sessions,
  staffBranchAssignments,
  staffInvitations,
  staffProfiles,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { createSession, validateSessionToken } from "@/lib/auth/session";
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";
import { captureInvitations } from "@/lib/testing/staff-invitation-helpers";
import { checkAcademyAccess } from "./access-gate";
import { deleteAcademy } from "./delete-academy";
import { createStaff, type CreateStaffInput } from "./staff";
import {
  acceptStaffInvitation,
  acceptStaffInvitationWithNewAccount,
  describeStaffInvitation,
  listStaffInvitations,
  resendStaffInvitation,
  revokeStaffInvitation,
} from "./staff-invitations";

const userIds: string[] = [];
const academyIds: string[] = [];
const planIds: string[] = [];
const PASSWORD = "a-strong-test-password-123";

const ctx = (userId: string): AuthContext => ({ userId, branchIds: [], academyWide: false });

async function createUser(): Promise<{ id: string; email: string }> {
  const email = `sec-h01-${randomUUID()}@example.com`;
  const [user] = await db.insert(users).values({ email, passwordHash: "fixture-hash-not-real" }).returning({ id: users.id });
  userIds.push(user.id);
  return { id: user.id, email };
}

async function createAcademy(): Promise<string> {
  const creator = await createUser();
  const [academy] = await db
    .insert(academies)
    .values({ name: `SEC-H-01 Academy ${randomUUID()}`, slug: `sec-h01-${randomUUID()}`, defaultCurrency: "USD", createdBy: creator.id })
    .returning({ id: academies.id });
  academyIds.push(academy.id);
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      isActive: false,
      description: "SEC-H-01 fixture",
      name: `SEC-H-01 Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 5,
      maxStudents: 100,
      maxStaff: 50,
      maxCourses: 10,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  planIds.push(plan.id);
  await db.insert(academySubscriptions).values({ academyId: academy.id, planId: plan.id, status: "active", createdBy: creator.id });
  return academy.id;
}

async function addMember(academyId: string, role: AcademyRole, branchIds: string[] = []): Promise<{ id: string; email: string; profileId: string }> {
  const user = await createUser();
  await db.insert(academyMemberships).values({ userId: user.id, academyId, role, status: "active", academyWide: legacyAllBranchAccess(role) && branchIds.length === 0 });
  const [profile] = await db
    .insert(staffProfiles)
    .values({ academyId, userId: user.id, fullName: `Member ${role}`, phone: "+1-555-0100", email: user.email })
    .returning({ id: staffProfiles.id });
  for (const branchId of branchIds) await db.insert(staffBranchAssignments).values({ academyId, staffProfileId: profile.id, branchId });
  return { ...user, profileId: profile.id };
}

async function addBranch(academyId: string, isMain = false): Promise<string> {
  const code = `B-${randomUUID().slice(0, 8)}`;
  const [row] = await db.insert(branches).values({ academyId, name: `Branch ${code}`, code, isMain }).returning({ id: branches.id });
  return row.id;
}

function input(email: string, overrides: Partial<CreateStaffInput> = {}): CreateStaffInput {
  return { email, fullName: "Invited Person", phone: "+1-555-0123", role: "trainer", ...overrides };
}

/** Invite through the real createStaff path, capturing the emailed token. */
async function invite(actor: string, email: string, overrides: Partial<CreateStaffInput> = {}) {
  const mail = captureInvitations();
  const result = await createStaff(ctx(actor), input(email, overrides), { deliver: mail.deliver });
  return { result, token: mail.lastToken() };
}

const membershipsOf = (userId: string) =>
  db.select().from(academyMemberships).where(eq(academyMemberships.userId, userId)).orderBy(academyMemberships.academyId);

const invitationRow = async (id: string) => (await db.select().from(staffInvitations).where(eq(staffInvitations.id, id)))[0];

afterAll(async () => {
  await db.delete(auditLogs).where(or(inArray(auditLogs.academyId, academyIds), inArray(auditLogs.actorUserId, userIds)));
  await db.delete(sessions).where(inArray(sessions.userId, userIds));
  for (const academyId of academyIds) {
    await db.delete(staffBranchAssignments).where(eq(staffBranchAssignments.academyId, academyId));
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(staffInvitations).where(eq(staffInvitations.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of planIds) await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  for (const userId of userIds) await db.delete(users).where(eq(users.id, userId));
}, 240_000);

describe("SEC-H-01 — no direct attachment (tests 1, 2, 3, 10)", () => {
  it("Academy B's invitation never attaches Academy A's user; A's membership, password and session are untouched", async () => {
    const A = await createAcademy();
    const B = await createAcademy();
    const victim = await addMember(A, "trainer");
    const bOwner = await addMember(B, "academy_owner");
    const { token: sessionToken } = await createSession(victim.id);
    const [userBefore] = await db.select().from(users).where(eq(users.id, victim.id));
    const membershipsBefore = await membershipsOf(victim.id);

    const { result } = await invite(bOwner.id, victim.email);
    expect(result.ok).toBe(true);

    // 1: nothing in B.
    const inB = await db.select().from(academyMemberships).where(and(eq(academyMemberships.userId, victim.id), eq(academyMemberships.academyId, B)));
    expect(inB).toHaveLength(0);
    const profileInB = await db.select().from(staffProfiles).where(and(eq(staffProfiles.userId, victim.id), eq(staffProfiles.academyId, B)));
    expect(profileInB).toHaveLength(0);
    // 2: A membership identical.
    expect(await membershipsOf(victim.id)).toEqual(membershipsBefore);
    // 3: password and session unchanged.
    const [userAfter] = await db.select().from(users).where(eq(users.id, victim.id));
    expect(userAfter.passwordHash).toBe(userBefore.passwordHash);
    expect(userAfter.status).toBe(userBefore.status);
    expect(await validateSessionToken(sessionToken)).not.toBeNull();
    // 10: still reaches A.
    expect((await checkAcademyAccess(victim.id)).level).toBe("full");
  }, 120_000);

  it("even if A's user follows B's link and accepts, they are refused and keep access to A", async () => {
    const A = await createAcademy();
    const B = await createAcademy();
    const victim = await addMember(A, "trainer");
    const bOwner = await addMember(B, "academy_owner");
    const before = await membershipsOf(victim.id);

    const { token } = await invite(bOwner.id, victim.email);
    const accepted = await acceptStaffInvitation(ctx(victim.id), token);
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.error.code).toBe("conflict");

    expect(await membershipsOf(victim.id)).toEqual(before);
    expect((await checkAcademyAccess(victim.id)).level).toBe("full");
  }, 120_000);
});

describe("Acceptance binding (tests 4, 5)", () => {
  it("only the account the invitation was sent to can accept it", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const invitee = await createUser();
    const stranger = await createUser();

    const { result, token } = await invite(owner.id, invitee.email);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const wrong = await acceptStaffInvitation(ctx(stranger.id), token);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe("forbidden");
    expect((await invitationRow(result.invitationId)).status).toBe("pending");
    expect(await membershipsOf(stranger.id)).toHaveLength(0);

    const right = await acceptStaffInvitation(ctx(invitee.id), token);
    expect(right.ok).toBe(true);
    const memberships = await membershipsOf(invitee.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ academyId: academy, role: "trainer", status: "active" });
  }, 120_000);

  it("an existing account cannot be claimed through the new-account path", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const invitee = await createUser();
    const [before] = await db.select().from(users).where(eq(users.id, invitee.id));

    const { token } = await invite(owner.id, invitee.email);
    const attempt = await acceptStaffInvitationWithNewAccount(token, PASSWORD);
    expect(attempt.ok).toBe(false);
    const [after] = await db.select().from(users).where(eq(users.id, invitee.id));
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(await membershipsOf(invitee.id)).toHaveLength(0);
  }, 120_000);

  it("a new person sets their own password; the inviter never chooses it", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const email = `sec-h01-new-${randomUUID()}@example.com`;

    const { token } = await invite(owner.id, email);
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(0);

    const accepted = await acceptStaffInvitationWithNewAccount(token, PASSWORD);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    userIds.push(accepted.userId);
    const [user] = await db.select().from(users).where(eq(users.id, accepted.userId));
    expect(user.email).toBe(email);
    expect(user.passwordHash.startsWith("$argon2id$")).toBe(true);
  }, 120_000);
});

describe("Token lifecycle (tests 6, 7, 8)", () => {
  it("rejects an expired invitation on both acceptance paths", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const invitee = await createUser();
    const { result, token } = await invite(owner.id, invitee.email);
    if (!result.ok) throw new Error("invite failed");
    await db.update(staffInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(staffInvitations.id, result.invitationId));

    const accepted = await acceptStaffInvitation(ctx(invitee.id), token);
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.error.code).toBe("not_found");

    const fresh = `sec-h01-exp-${randomUUID()}@example.com`;
    const second = await invite(owner.id, fresh);
    if (!second.result.ok) throw new Error("invite failed");
    await db.update(staffInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(staffInvitations.id, second.result.invitationId));
    const created = await acceptStaffInvitationWithNewAccount(second.token, PASSWORD);
    expect(created.ok).toBe(false);
    expect(await db.select().from(users).where(eq(users.email, fresh))).toHaveLength(0);
  }, 120_000);

  it("a used invitation cannot be used again", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const email = `sec-h01-once-${randomUUID()}@example.com`;
    const { token } = await invite(owner.id, email);

    const first = await acceptStaffInvitationWithNewAccount(token, PASSWORD);
    expect(first.ok).toBe(true);
    if (first.ok) userIds.push(first.userId);

    const replayNew = await acceptStaffInvitationWithNewAccount(token, PASSWORD);
    expect(replayNew.ok).toBe(false);
    if (!replayNew.ok) expect(replayNew.error.code).toBe("not_found");
    if (first.ok) {
      const replaySignedIn = await acceptStaffInvitation(ctx(first.userId), token);
      expect(replaySignedIn.ok).toBe(false);
      if (!replaySignedIn.ok) expect(replaySignedIn.error.code).toBe("not_found");
    }
  }, 120_000);

  it("concurrent acceptances create exactly one membership and one profile", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const invitee = await createUser();
    const { token } = await invite(owner.id, invitee.email);

    const results = await Promise.all([1, 2, 3, 4].map(() => acceptStaffInvitation(ctx(invitee.id), token)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.select().from(academyMemberships).where(and(eq(academyMemberships.userId, invitee.id), eq(academyMemberships.academyId, academy)))).toHaveLength(1);
    expect(await db.select().from(staffProfiles).where(and(eq(staffProfiles.userId, invitee.id), eq(staffProfiles.academyId, academy)))).toHaveLength(1);
  }, 120_000);

  it("concurrent new-account acceptances create exactly one account", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const email = `sec-h01-race-${randomUUID()}@example.com`;
    const { token } = await invite(owner.id, email);

    const results = await Promise.all([1, 2, 3].map(() => acceptStaffInvitationWithNewAccount(token, PASSWORD)));
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    for (const r of ok) if (r.ok) userIds.push(r.userId);
    expect(await db.select().from(users).where(eq(users.email, email))).toHaveLength(1);
  }, 120_000);

  it("only the token's hash is stored, and resend invalidates the old link", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const invitee = await createUser();
    const { result, token } = await invite(owner.id, invitee.email);
    if (!result.ok) throw new Error("invite failed");
    const row = await invitationRow(result.invitationId);
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));

    const mail = captureInvitations();
    const resent = await resendStaffInvitation(ctx(owner.id), result.invitationId, { deliver: mail.deliver });
    expect(resent.ok).toBe(true);
    const stale = await acceptStaffInvitation(ctx(invitee.id), token);
    expect(stale.ok).toBe(false);
    const fresh = await acceptStaffInvitation(ctx(invitee.id), mail.lastToken());
    expect(fresh.ok).toBe(true);
  }, 120_000);
});

describe("Scope cannot exceed what was authorized (test 9)", () => {
  it("a Manager cannot invite above Trainer, and an accepted invitation grants exactly its role and branches", async () => {
    const academy = await createAcademy();
    const branchX = await addBranch(academy, true);
    const branchY = await addBranch(academy);
    const manager = await addMember(academy, "manager", [branchX]);

    for (const role of ["academy_admin", "academy_owner", "manager", "admissions_officer", "finance_officer"] as const) {
      const attempt = await invite(manager.id, `sec-h01-esc-${randomUUID()}@example.com`, { role });
      expect(attempt.result.ok, role).toBe(false);
    }
    // Outside the Manager's own branch.
    const outside = await invite(manager.id, `sec-h01-y-${randomUUID()}@example.com`, { workplace: "specific", branchIds: [branchY] });
    expect(outside.result.ok).toBe(false);
    // All branches is owner-only.
    const all = await invite(manager.id, `sec-h01-all-${randomUUID()}@example.com`, { workplace: "all" });
    expect(all.result.ok).toBe(false);

    const invitee = await createUser();
    const ok = await invite(manager.id, invitee.email, { workplace: "specific", branchIds: [branchX] });
    expect(ok.result.ok).toBe(true);
    const accepted = await acceptStaffInvitation(ctx(invitee.id), ok.token);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const [membership] = await db.select().from(academyMemberships).where(and(eq(academyMemberships.userId, invitee.id), eq(academyMemberships.academyId, academy)));
    expect(membership).toMatchObject({ role: "trainer", academyWide: false, status: "active" });
    const assigned = await db.select({ branchId: staffBranchAssignments.branchId }).from(staffBranchAssignments).where(eq(staffBranchAssignments.staffProfileId, accepted.staffProfileId));
    expect(assigned.map((a) => a.branchId)).toEqual([branchX]);
  }, 120_000);

  it("an invitation stops working if the inviter loses the authority to grant it", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const admin = await addMember(academy, "academy_admin");
    const invitee = await createUser();
    const { token } = await invite(admin.id, invitee.email, { role: "manager" });

    // The admin is demoted to Trainer before the invitation is accepted.
    await db.update(academyMemberships).set({ role: "trainer" }).where(and(eq(academyMemberships.userId, admin.id), eq(academyMemberships.academyId, academy)));
    const accepted = await acceptStaffInvitation(ctx(invitee.id), token);
    expect(accepted.ok).toBe(false);
    expect(await membershipsOf(invitee.id)).toHaveLength(0);
    void owner;
  }, 120_000);
});

describe("No account enumeration (tests 11, 12)", () => {
  it("existing and unknown emails get the same response shape and values", async () => {
    const A = await createAcademy();
    const B = await createAcademy();
    const bOwner = await addMember(B, "academy_owner");
    const elsewhere = await addMember(A, "trainer"); // account in another academy
    const bare = await createUser(); // account with no membership
    const unknown = `sec-h01-unknown-${randomUUID()}@example.com`;

    const strip = (r: Awaited<ReturnType<typeof createStaff>>) => {
      if (!r.ok) return r;
      const { invitationId, email, ...rest } = r;
      void invitationId;
      void email;
      return rest;
    };
    const responses = await Promise.all([elsewhere.email, bare.email, unknown].map((email) => invite(bOwner.id, email).then((x) => x.result)));
    for (const r of responses) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(Object.keys(r).sort()).toEqual(["email", "emailSent", "invitationId", "ok", "role"]);
    }
    expect(strip(responses[0])).toEqual(strip(responses[2]));
    expect(strip(responses[1])).toEqual(strip(responses[2]));
  }, 120_000);

  it("response time does not depend on whether the email has an account", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const other = await createAcademy();
    const existing: string[] = [];
    for (let i = 0; i < 6; i += 1) existing.push((await addMember(other, "trainer")).email);
    const unknown = Array.from({ length: 6 }, () => `sec-h01-t-${randomUUID()}@example.com`);

    const time = async (email: string) => {
      const started = performance.now();
      const { result } = await invite(owner.id, email);
      expect(result.ok).toBe(true);
      return performance.now() - started;
    };
    const tExisting: number[] = [];
    const tUnknown: number[] = [];
    // Interleaved so network drift affects both groups alike.
    for (let i = 0; i < 6; i += 1) {
      tExisting.push(await time(existing[i]));
      tUnknown.push(await time(unknown[i]));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const diff = Math.abs(median(tExisting) - median(tUnknown));
    // The issue path never reads `users`; any gap is remote-database jitter.
    expect(diff, `median existing ${median(tExisting).toFixed(0)}ms vs unknown ${median(tUnknown).toFixed(0)}ms`).toBeLessThan(
      Math.max(150, 0.5 * Math.min(median(tExisting), median(tUnknown))),
    );
  }, 240_000);
});

describe("Who may create and revoke invitations (test 13)", () => {
  it("trainers cannot invite, revoke or resend; other academies cannot touch an invitation; a Manager cannot cancel an Admin's invitation", async () => {
    const academy = await createAcademy();
    const other = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const trainer = await addMember(academy, "trainer");
    const manager = await addMember(academy, "manager");
    const otherOwner = await addMember(other, "academy_owner");

    const byTrainer = await invite(trainer.id, `sec-h01-tr-${randomUUID()}@example.com`);
    expect(byTrainer.result.ok).toBe(false);
    if (!byTrainer.result.ok) expect(byTrainer.result.error.code).toBe("forbidden");

    const adminInvite = await invite(owner.id, `sec-h01-adm-${randomUUID()}@example.com`, { role: "academy_admin" });
    if (!adminInvite.result.ok) throw new Error("invite failed");
    const id = adminInvite.result.invitationId;

    for (const actor of [trainer.id, manager.id, otherOwner.id]) {
      const revoked = await revokeStaffInvitation(ctx(actor), id);
      expect(revoked.ok).toBe(false);
      const resent = await resendStaffInvitation(ctx(actor), id, { deliver: async () => true });
      expect(resent.ok).toBe(false);
    }
    // The Manager doesn't even see it; the other academy can't list it.
    const managerList = await listStaffInvitations(ctx(manager.id));
    expect(managerList.ok && managerList.invitations.some((i) => i.id === id)).toBe(false);
    const otherList = await listStaffInvitations(ctx(otherOwner.id));
    expect(otherList.ok && otherList.invitations.some((i) => i.id === id)).toBe(false);
    expect((await invitationRow(id)).status).toBe("pending");

    // The owner can revoke, and a revoked link can't be accepted.
    expect((await revokeStaffInvitation(ctx(owner.id), id)).ok).toBe(true);
    const late = await acceptStaffInvitationWithNewAccount(adminInvite.token, PASSWORD);
    expect(late.ok).toBe(false);
  }, 120_000);
});

describe("Audit trail (test 14)", () => {
  it("records create, resend, accept and revoke, and never the token", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const invitee = await createUser();

    const first = await invite(owner.id, invitee.email);
    if (!first.result.ok) throw new Error("invite failed");
    const mail = captureInvitations();
    await resendStaffInvitation(ctx(owner.id), first.result.invitationId, { deliver: mail.deliver });
    const accepted = await acceptStaffInvitation(ctx(invitee.id), mail.lastToken());
    expect(accepted.ok).toBe(true);

    const second = await invite(owner.id, `sec-h01-rv-${randomUUID()}@example.com`);
    if (!second.result.ok) throw new Error("invite failed");
    await revokeStaffInvitation(ctx(owner.id), second.result.invitationId);

    const firstId = first.result.invitationId;
    const secondId = second.result.invitationId;
    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.academyId, academy), inArray(auditLogs.entityId, [firstId, secondId])));
    const actions = rows.map((r) => `${r.action}:${r.entityId === firstId ? 1 : 2}`).sort();
    expect(actions).toEqual(
      ["acceptStaffInvitation:1", "createStaffInvitation:1", "createStaffInvitation:2", "resendStaffInvitation:1", "revokeStaffInvitation:2"].sort(),
    );
    const accept = rows.find((r) => r.action === "acceptStaffInvitation");
    expect(accept?.actorUserId).toBe(invitee.id);
    const serialized = JSON.stringify(rows);
    for (const token of [first.token, mail.lastToken(), second.token]) expect(serialized).not.toContain(token);
  }, 120_000);
});

describe("Return after sign-in: the page re-checks everything and never accepts by itself", () => {
  it("signed out -> sign_in; signed in as the invitee -> accept (still pending until Accept is pressed)", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const invitee = await createUser();
    const { result, token } = await invite(owner.id, invitee.email);
    if (!result.ok) throw new Error("invite failed");

    expect(await describeStaffInvitation(token, null)).toMatchObject({ valid: true, mode: "sign_in", email: invitee.email });
    const afterReturn = await describeStaffInvitation(token, ctx(invitee.id));
    expect(afterReturn).toMatchObject({ valid: true, mode: "accept" });
    // Viewing the page after sign-in does not accept it.
    expect((await invitationRow(result.invitationId)).status).toBe("pending");
    expect(await membershipsOf(invitee.id)).toHaveLength(0);

    const accepted = await acceptStaffInvitation(ctx(invitee.id), token);
    expect(accepted.ok).toBe(true);
    expect(await describeStaffInvitation(token, ctx(invitee.id))).toEqual({ valid: false });
  }, 120_000);

  it("returning signed in as a different account shows wrong_account and cannot accept", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const invitee = await createUser();
    const other = await createUser();
    const { result, token } = await invite(owner.id, invitee.email);
    if (!result.ok) throw new Error("invite failed");

    expect(await describeStaffInvitation(token, ctx(other.id))).toMatchObject({ valid: true, mode: "wrong_account" });
    const attempt = await acceptStaffInvitation(ctx(other.id), token);
    expect(attempt.ok).toBe(false);
    expect((await invitationRow(result.invitationId)).status).toBe("pending");
  }, 120_000);

  it("an invitation that expired while the person was signing in is shown as unavailable and cannot be accepted", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const invitee = await createUser();
    const { result, token } = await invite(owner.id, invitee.email);
    if (!result.ok) throw new Error("invite failed");
    await db.update(staffInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(staffInvitations.id, result.invitationId));

    expect(await describeStaffInvitation(token, ctx(invitee.id))).toEqual({ valid: false });
    expect((await acceptStaffInvitation(ctx(invitee.id), token)).ok).toBe(false);
  }, 120_000);
});

describe("Academy deletion removes that academy's invitations only", () => {
  it("deletes pending, accepted and revoked invitations of the deleted academy and leaves other academies' alone", async () => {
    const doomed = await createAcademy();
    const kept = await createAcademy();
    const doomedOwner = await addMember(doomed, "academy_owner");
    const keptOwner = await addMember(kept, "academy_owner");

    const pending = await invite(doomedOwner.id, `sec-h01-del-p-${randomUUID()}@example.com`);
    const toRevoke = await invite(doomedOwner.id, `sec-h01-del-r-${randomUUID()}@example.com`);
    const accepter = await createUser();
    const toAccept = await invite(doomedOwner.id, accepter.email);
    const other = await invite(keptOwner.id, `sec-h01-del-k-${randomUUID()}@example.com`);
    for (const r of [pending, toRevoke, toAccept, other]) expect(r.result.ok).toBe(true);
    if (!toRevoke.result.ok || !other.result.ok) return;
    expect((await revokeStaffInvitation(ctx(doomedOwner.id), toRevoke.result.invitationId)).ok).toBe(true);
    expect((await acceptStaffInvitation(ctx(accepter.id), toAccept.token)).ok).toBe(true);

    const platformOwner = await createUser();
    const [{ name }] = await db.select({ name: academies.name }).from(academies).where(eq(academies.id, doomed));
    const deleted = await deleteAcademy({ userId: platformOwner.id, platformRole: "platform_owner", branchIds: [], academyWide: false }, doomed, name);
    expect(deleted.ok).toBe(true);

    expect(await db.select().from(staffInvitations).where(eq(staffInvitations.academyId, doomed))).toHaveLength(0);
    expect((await invitationRow(other.result.invitationId))?.status).toBe("pending");
    // A link to the deleted academy no longer works.
    expect(await describeStaffInvitation(pending.token, null)).toEqual({ valid: false });
  }, 120_000);
});
