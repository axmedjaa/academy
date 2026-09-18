/**
 * PLAN.md Phase 5, Item 65 — full Playwright coverage.
 *
 * Seed/fixture approach (documented per this item's own brief, which
 * offers two options and says to pick the simpler/lower-risk one):
 *
 * `scripts/seed.ts` (Phase 0) only ever creates a single MFA-enrolled
 * `platform_owner` — its own comment says the full demo dataset (academy,
 * branches, students...) is "a later-phase concern once those tables
 * exist." Extending it additively to drive the *real* multi-step
 * onboarding flow (registerAcademy -> createAcademySubscription ->
 * recordSubscriptionPayment -> verifySubscriptionPayment -> approveAcademy
 * -> activateAcademy) for two full academies would be the highest-fidelity
 * option, but it's also the highest-risk one to bolt onto a shared,
 * already-shipped script: every one of those steps requires a full
 * `AuthContext` for a `platform_owner` actor, multiple Zod-validated
 * inputs, and touches `scripts/seed.ts`'s existing, already-tested output.
 *
 * Option (b) — a dedicated `e2e/fixtures/seed-e2e.ts` fixture, called only
 * from Playwright's own `globalSetup` — is what this file is. It builds
 * the same *shape* of data those actions would produce (two independent,
 * active-subscription academies, each with an owner, a branch, a program/
 * course/batch, students, and one issued certificate) via direct,
 * idempotent inserts, the same pattern this repo's own Vitest integration
 * tests already use for fixture setup (see e.g.
 * lib/academies/lifecycle.test.ts's createAcademy/createSubscription
 * helpers) rather than driving the full onboarding UI/action chain. This
 * is lower-risk (touches no shared script, no existing seed row), simpler
 * (no AuthContext/session plumbing needed for a script that isn't a real
 * actor), and sufficient: PLAN.md's Playwright acceptance bar is about
 * exercising real pages/requests as a signed-in user against real tenant
 * data, not about re-proving the onboarding *state machine* itself (that's
 * already covered by lib/academies/lifecycle.test.ts and friends).
 *
 * Safely re-runnable: every insert is get-or-create, keyed by the fixture's
 * own stable slugs/codes/emails (never a fresh randomUUID() per run), so
 * running the whole Playwright suite repeatedly (local iteration, CI retries)
 * never creates duplicate rows or violates a unique constraint.
 *
 * Never touches `scripts/seed.ts` or any of its rows, and never removes or
 * modifies application data — additive-only, same posture the parent task
 * requires of any `scripts/seed.ts` change, applied here to a fixture file
 * instead.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  batches,
  branches,
  certificates,
  courses,
  programs,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { ACADEMY_A, ACADEMY_B, E2E_PLAN_NAME, type E2EAcademyFixture } from "./constants";

async function getOrCreateUser(email: string, password: string): Promise<string> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) return existing.id;

  const passwordHash = await hashPassword(password);
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash })
    .returning({ id: users.id });
  return row.id;
}

async function getOrCreatePlan(name: string): Promise<string> {
  const [existing] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.name, name))
    .limit(1);
  if (existing) return existing.id;

  // Generous limits — this plan exists only so both E2E academies have an
  // `active` subscription; allowance-limit testing is out of this item's
  // reduced scope (see this item's own brief: "breadth of risk over
  // breadth of pages").
  const [row] = await db
    .insert(subscriptionPlans)
    .values({
      name,
      priceAmountCents: 0,
      currency: "USD",
      billingPeriod: "annual",
      maxBranches: 10,
      maxStudents: 1000,
      maxStaff: 100,
      maxCourses: 100,
      maxStorageBytes: 10_737_418_240,
      smsEnabled: true,
      emailEnabled: true,
      certificateEnabled: true,
      reportsLevel: "advanced",
      isActive: true,
    })
    .returning({ id: subscriptionPlans.id });
  return row.id;
}

async function getOrCreateAcademy(
  slug: string,
  name: string,
  ownerId: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: academies.id })
    .from(academies)
    .where(eq(academies.slug, slug))
    .limit(1);
  if (existing) return existing.id;

  const [row] = await db
    .insert(academies)
    .values({
      name,
      slug,
      defaultCurrency: "USD",
      createdBy: ownerId,
      approvedBy: ownerId,
      approvedAt: new Date(),
    })
    .returning({ id: academies.id });
  return row.id;
}

async function getOrCreateBranch(
  academyId: string,
  code: string,
  name: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.academyId, academyId), eq(branches.code, code)))
    .limit(1);
  if (existing) return existing.id;

  const [row] = await db
    .insert(branches)
    .values({ academyId, code, name })
    .returning({ id: branches.id });
  return row.id;
}

async function ensureMembership(userId: string, academyId: string): Promise<void> {
  const [existing] = await db
    .select({ id: academyMemberships.id })
    .from(academyMemberships)
    .where(and(eq(academyMemberships.userId, userId), eq(academyMemberships.academyId, academyId)))
    .limit(1);
  if (existing) return;

  await db.insert(academyMemberships).values({
    userId,
    academyId,
    role: "academy_owner",
    status: "active",
  });
}

async function ensureActiveSubscription(
  academyId: string,
  planId: string,
  ownerId: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: academySubscriptions.id })
    .from(academySubscriptions)
    .where(eq(academySubscriptions.academyId, academyId))
    .limit(1);
  if (existing) return;

  const now = new Date();
  const oneYearOut = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
    startsAt: now,
    endsAt: oneYearOut,
    activatedAt: now,
    createdBy: ownerId,
  });
}

async function getOrCreateProgram(academyId: string, name: string): Promise<string> {
  const [existing] = await db
    .select({ id: programs.id })
    .from(programs)
    .where(and(eq(programs.academyId, academyId), eq(programs.name, name)))
    .limit(1);
  if (existing) return existing.id;

  const [row] = await db
    .insert(programs)
    .values({ academyId, name })
    .returning({ id: programs.id });
  return row.id;
}

async function getOrCreateCourse(
  academyId: string,
  programId: string,
  name: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.academyId, academyId), eq(courses.name, name)))
    .limit(1);
  if (existing) return existing.id;

  const [row] = await db
    .insert(courses)
    .values({ academyId, programId, name })
    .returning({ id: courses.id });
  return row.id;
}

async function getOrCreateBatch(
  academyId: string,
  branchId: string,
  courseId: string,
  code: string,
  name: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: batches.id })
    .from(batches)
    .where(and(eq(batches.academyId, academyId), eq(batches.code, code)))
    .limit(1);
  if (existing) return existing.id;

  const startDate = new Date().toISOString().slice(0, 10);
  const [row] = await db
    .insert(batches)
    .values({
      academyId,
      branchId,
      courseId,
      code,
      name,
      startDate,
      status: "active",
    })
    .returning({ id: batches.id });
  return row.id;
}

async function getOrCreateStudent(
  academyId: string,
  branchId: string,
  ownerId: string,
  studentNumber: string,
  fullName: string,
): Promise<string> {
  const [existing] = await db
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.academyId, academyId), eq(students.studentNumber, studentNumber)))
    .limit(1);
  if (existing) return existing.id;

  const [row] = await db
    .insert(students)
    .values({
      academyId,
      branchId,
      studentNumber,
      fullName,
      createdBy: ownerId,
    })
    .returning({ id: students.id });
  return row.id;
}

async function ensureCertificate(
  academyId: string,
  studentId: string,
  batchId: string,
  ownerId: string,
  certificateCode: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: certificates.id })
    .from(certificates)
    .where(eq(certificates.certificateCode, certificateCode))
    .limit(1);
  if (existing) return;

  // Direct insert deliberately bypasses issueCertificate's eligibility
  // check (a published+pass exam_results row) — this is fixture data for
  // the public /verify/[certificateCode] page's own E2E test, not a test
  // of the certificate-issuance eligibility rule itself (already covered
  // by lib/academies/certificates.test.ts).
  await db.insert(certificates).values({
    academyId,
    studentId,
    batchId,
    certificateCode,
    issuedAt: new Date(),
    issuedBy: ownerId,
    status: "issued",
  });
}

async function seedAcademy(fixture: E2EAcademyFixture, planId: string): Promise<void> {
  const ownerId = await getOrCreateUser(fixture.ownerEmail, fixture.ownerPassword);
  const academyId = await getOrCreateAcademy(fixture.slug, fixture.name, ownerId);
  const branchId = await getOrCreateBranch(academyId, fixture.branchCode, fixture.branchName);

  await ensureMembership(ownerId, academyId);
  await ensureActiveSubscription(academyId, planId, ownerId);

  const programId = await getOrCreateProgram(academyId, fixture.programName);
  const courseId = await getOrCreateCourse(academyId, programId, fixture.courseName);
  const batchId = await getOrCreateBatch(
    academyId,
    branchId,
    courseId,
    fixture.batchCode,
    fixture.batchName,
  );

  const studentId = await getOrCreateStudent(
    academyId,
    branchId,
    ownerId,
    fixture.studentNumber,
    fixture.studentName,
  );
  await getOrCreateStudent(
    academyId,
    branchId,
    ownerId,
    fixture.secondStudentNumber,
    fixture.secondStudentName,
  );

  await ensureCertificate(academyId, studentId, batchId, ownerId, fixture.certificateCode);
}

/**
 * Called once from e2e/global-setup.ts before the whole Playwright suite
 * runs. Idempotent — safe to call on every `npm run test:e2e` invocation.
 */
export async function seedE2EFixtures(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed E2E fixtures: NODE_ENV=production.");
  }

  const planId = await getOrCreatePlan(E2E_PLAN_NAME);
  await seedAcademy(ACADEMY_A, planId);
  await seedAcademy(ACADEMY_B, planId);
}

/**
 * Looks up a fixture batch's real (live) id by academy slug + batch code.
 * Used by the cross-tenant isolation spec to build a genuine
 * `/academy/batches/[batchId]` URL for "Academy B's real id, requested
 * while signed in as Academy A" — never a hardcoded/guessed UUID, since
 * the point of that test is to hit a row that actually exists.
 */
export async function getBatchIdForAcademy(slug: string, batchCode: string): Promise<string> {
  const [row] = await db
    .select({ id: batches.id })
    .from(batches)
    .innerJoin(academies, eq(batches.academyId, academies.id))
    .where(and(eq(academies.slug, slug), eq(batches.code, batchCode)))
    .limit(1);

  if (!row) {
    throw new Error(
      `E2E fixture batch not found for academy slug=${slug}, code=${batchCode}. Did global setup run?`,
    );
  }
  return row.id;
}
