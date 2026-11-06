/**
 * Pre-deployment security audit (SECURITY_AUDIT_PRE_DEPLOYMENT.md, SEC-H-01):
 * cross-tenant account attachment through "Add staff".
 *
 * These tests state the SECURE behaviour. They are expected to FAIL against
 * the code as audited; they should pass once SEC-H-01 is fixed. They run only
 * against TEST_DATABASE_URL (vitest.config.ts refuses the DEV database) and
 * remove every row they create.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  staffBranchAssignments,
  staffInvitations,
  staffProfiles,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";
import { checkAcademyAccess } from "./access-gate";
import { createStaff } from "./staff";

const userIds: string[] = [];
const academyIds: string[] = [];
const planIds: string[] = [];

async function createUser(): Promise<{ id: string; email: string }> {
  const email = `sec-audit-${randomUUID()}@example.com`;
  const [user] = await db.insert(users).values({ email, passwordHash: "not-a-real-hash" }).returning({ id: users.id });
  userIds.push(user.id);
  return { id: user.id, email };
}

async function createAcademyWithMember(role: AcademyRole): Promise<{ academyId: string; member: { id: string; email: string }; context: AuthContext }> {
  const creator = await createUser();
  const [academy] = await db
    .insert(academies)
    .values({ name: `Security Audit Academy ${randomUUID()}`, slug: `sec-audit-${randomUUID()}`, defaultCurrency: "USD", createdBy: creator.id })
    .returning({ id: academies.id });
  academyIds.push(academy.id);
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      isActive: false,
      description: "Security audit fixture",
      name: `Security Audit Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 3,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses: 10,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  planIds.push(plan.id);
  await db.insert(academySubscriptions).values({ academyId: academy.id, planId: plan.id, status: "active", createdBy: creator.id });
  const member = await createUser();
  await db.insert(academyMemberships).values({ userId: member.id, academyId: academy.id, role, status: "active", academyWide: legacyAllBranchAccess(role) });
  return { academyId: academy.id, member, context: { userId: member.id, branchIds: [], academyWide: false } };
}

afterAll(async () => {
  await db.delete(auditLogs).where(or(inArray(auditLogs.academyId, academyIds), inArray(auditLogs.actorUserId, userIds)));
  for (const academyId of academyIds) {
    await db.delete(staffBranchAssignments).where(eq(staffBranchAssignments.academyId, academyId));
    await db.delete(staffProfiles).where(eq(staffProfiles.academyId, academyId));
    await db.delete(staffInvitations).where(eq(staffInvitations.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of planIds) await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  for (const userId of userIds) await db.delete(users).where(eq(users.id, userId));
}, 240_000);

describe("SEC-H-01: Add staff must not attach another academy's existing account", () => {
  it("Academy B cannot add Academy A's staff member by email, and A's member keeps access to A", async () => {
    const a = await createAcademyWithMember("trainer");
    const b = await createAcademyWithMember("academy_owner");

    // Sanity: the victim can use Academy A before the attack.
    const before = await checkAcademyAccess(a.member.id);
    expect(before.level).toBe("full");

    const result = await createStaff(b.context, {
      email: a.member.email,
      fullName: "Attached Without Consent",
      phone: "+1-555-0100",
      employeeNumber: "SEC-1",
      hireDate: "2024-01-01",
      role: "trainer",
    }, { deliver: async () => true });

    // Secure behaviour: refused (or turned into an invitation the account
    // holder must accept) — never an immediate active membership.
    const [attached] = await db
      .select({ status: academyMemberships.status })
      .from(academyMemberships)
      .where(and(eq(academyMemberships.userId, a.member.id), eq(academyMemberships.academyId, b.academyId)));
    expect.soft(
      attached?.status ?? "none",
      `createStaff returned ${result.ok ? "ok" : result.error.code}; membership in B is ${attached?.status ?? "none"}`,
    ).not.toBe("active");

    // And the victim must still reach Academy A afterwards.
    const after = await checkAcademyAccess(a.member.id);
    expect.soft(after.level, `victim's access to their own academy became: ${after.level === "blocked" ? after.reason : after.level}`).toBe("full");
  }, 120_000);
});
