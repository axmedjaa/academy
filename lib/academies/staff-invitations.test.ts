/**
 * LEGACY staff invitations (SEC-H-01). Staff are now created directly
 * (lib/academies/staff.ts createStaff) and no invitation is issued or
 * re-sent; invitations already pending keep working until they expire or
 * are cancelled. These tests seed such invitations the way the retired flow
 * stored them, and check that acceptance keeps every SEC-H-01 guarantee:
 * only the owner of the invited email — signed in as that account, or
 * creating it with their own password — can turn one into access. Runs
 * against TEST_DATABASE_URL only and removes every row it creates.
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
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";
import { TEST_TEMPORARY_PASSWORD, seedLegacyInvitation } from "@/lib/testing/staff-account-helpers";
import * as invitationModule from "./staff-invitations";
import { checkAcademyAccess } from "./access-gate";
import { deleteAcademy } from "./delete-academy";
import { createStaff } from "./staff";
import {
  acceptStaffInvitation,
  acceptStaffInvitationWithNewAccount,
  describeStaffInvitation,
  listStaffInvitations,
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
  academyOfInviter.set(user.id, academyId);
  return { ...user, profileId: profile.id };
}

async function addBranch(academyId: string, isMain = false): Promise<string> {
  const code = `B-${randomUUID().slice(0, 8)}`;
  const [row] = await db.insert(branches).values({ academyId, name: `Branch ${code}`, code, isMain }).returning({ id: branches.id });
  return row.id;
}

interface InviteOptions {
  role?: AcademyRole;
  branchIds?: string[];
  academyWide?: boolean;
  expiresAt?: Date;
}

const academyOfInviter = new Map<string, string>();

/** A pending invitation from `actor`, stored as the retired flow stored it. */
async function invite(actor: string, email: string, options: InviteOptions = {}) {
  const academyId = academyOfInviter.get(actor);
  if (!academyId) throw new Error("inviter has no fixture academy");
  const seeded = await seedLegacyInvitation({ academyId, invitedBy: actor, email, ...options });
  return { result: { ok: true as const, invitationId: seeded.invitationId }, token: seeded.token };
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

describe("SEC-H-01 — no attachment through a legacy invitation", () => {
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
    const { token } = await invite(owner.id, invitee.email, { expiresAt: new Date(Date.now() - 1000) });

    const accepted = await acceptStaffInvitation(ctx(invitee.id), token);
    expect(accepted.ok).toBe(false);
    if (!accepted.ok) expect(accepted.error.code).toBe("not_found");

    const fresh = `sec-h01-exp-${randomUUID()}@example.com`;
    const second = await invite(owner.id, fresh, { expiresAt: new Date(Date.now() - 1000) });
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

  it("only the token's hash is stored", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const invitee = await createUser();
    const { result, token } = await invite(owner.id, invitee.email);
    if (!result.ok) throw new Error("invite failed");
    const row = await invitationRow(result.invitationId);
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect((await acceptStaffInvitation(ctx(invitee.id), token)).ok).toBe(true);
  }, 120_000);
});

describe("Scope cannot exceed what was authorized (test 9)", () => {
  it("an accepted invitation grants exactly its role and branches", async () => {
    const academy = await createAcademy();
    const branchX = await addBranch(academy, true);
    const manager = await addMember(academy, "manager", [branchX]);

    const invitee = await createUser();
    const ok = await invite(manager.id, invitee.email, { branchIds: [branchX] });
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

describe("Who may list and cancel legacy invitations", () => {
  it("trainers and other academies cannot cancel an invitation; a Manager cannot cancel an Admin's invitation", async () => {
    const academy = await createAcademy();
    const other = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const trainer = await addMember(academy, "trainer");
    const manager = await addMember(academy, "manager");
    const otherOwner = await addMember(other, "academy_owner");

    const adminInvite = await invite(owner.id, `sec-h01-adm-${randomUUID()}@example.com`, { role: "academy_admin" });
    if (!adminInvite.result.ok) throw new Error("invite failed");
    const id = adminInvite.result.invitationId;

    for (const actor of [trainer.id, manager.id, otherOwner.id]) {
      const revoked = await revokeStaffInvitation(ctx(actor), id);
      expect(revoked.ok).toBe(false);
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
  it("records accept and revoke, and never the token", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const invitee = await createUser();

    const first = await invite(owner.id, invitee.email);
    const accepted = await acceptStaffInvitation(ctx(invitee.id), first.token);
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
    expect(actions).toEqual(["acceptStaffInvitation:1", "revokeStaffInvitation:2"].sort());
    const accept = rows.find((r) => r.action === "acceptStaffInvitation");
    expect(accept?.actorUserId).toBe(invitee.id);
    const serialized = JSON.stringify(rows);
    for (const token of [first.token, second.token]) expect(serialized).not.toContain(token);
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
    const { token } = await invite(owner.id, invitee.email, { expiresAt: new Date(Date.now() - 1000) });

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

describe("Retired: no invitation is issued, re-sent or emailed", () => {
  it("the module no longer offers issuing, re-sending or emailing", () => {
    expect("issueStaffInvitation" in invitationModule).toBe(false);
    expect("resendStaffInvitation" in invitationModule).toBe(false);
    expect("deliverInvitationByEmail" in invitationModule).toBe(false);
  });

  it("creating staff writes no invitation row, and closes a pending legacy invitation for the same email", async () => {
    const academy = await createAcademy();
    const owner = await addMember(academy, "academy_owner");
    const email = `sec-h01-direct-${randomUUID()}@example.com`;
    const legacy = await invite(owner.id, email);

    const created = await createStaff(ctx(owner.id), {
      email,
      fullName: "Direct Person",
      phone: "+1-555-0123",
      role: "trainer",
      temporaryPassword: TEST_TEMPORARY_PASSWORD,
    });
    expect(created.ok).toBe(true);
    if (created.ok) userIds.push(created.userId);

    const rows = await db.select().from(staffInvitations).where(eq(staffInvitations.academyId, academy));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("revoked");
    // The old link no longer works.
    expect(await describeStaffInvitation(legacy.token, null)).toEqual({ valid: false });
  }, 120_000);
});
