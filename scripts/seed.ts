import { and, eq } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  batchEnrollments,
  batches,
  batchTrainerAssignments,
  branches,
  certificates,
  courses,
  examResults,
  exams,
  expenseRecords,
  gradeBands,
  gradeConfigurations,
  incomeRecords,
  platformMemberships,
  programs,
  staffBranchAssignments,
  staffProfiles,
  studentCharges,
  studentPayments,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { enrollMfaForUser, verifyMfaEnrollmentForUser } from "@/lib/auth/mfa";
import type { AcademyRole } from "@/lib/auth/roles";

// PLAN.md "Seed & Demonstration Data": guarded, refuses to run in
// production. This is the Phase 0 seed — just the one MFA-enrolled
// platform_owner; the full demo dataset (academy, branches, students...)
// is a later-phase concern once those tables exist.
if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run: seed script must not run in production.");
  process.exit(1);
}

// Demo credentials live only here (env-overridable) and in
// .env.example/README — never hardcoded as if they were real secrets.
const email = (
  process.env.SEED_PLATFORM_OWNER_EMAIL ?? "owner@example.com"
).toLowerCase();
const password =
  process.env.SEED_PLATFORM_OWNER_PASSWORD ?? "changeme-12345678";

async function main() {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    console.log(`Seed platform_owner already exists (${email}) — skipping.`);
  } else {
    const passwordHash = await hashPassword(password);
    const [user] = await db
      .insert(users)
      .values({ email, passwordHash })
      .returning({ id: users.id });

    await db
      .insert(platformMemberships)
      .values({ userId: user.id, role: "platform_owner" });

    // Drive the real enrollment flow (Item 13) rather than inserting a
    // pre-verified credential row directly, so the seeded account is
    // guaranteed consistent with what a real enrollment produces.
    const { secretBase32 } = await enrollMfaForUser(user.id);
    const currentCode = new OTPAuth.TOTP({
      issuer: "Academy Management SaaS",
      label: email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: secretBase32,
    }).generate();

    const verifyResult = await verifyMfaEnrollmentForUser(user.id, currentCode);
    if (!verifyResult.ok) {
      throw new Error(
        `Seed MFA verification unexpectedly failed: ${verifyResult.error.message}`,
      );
    }

    console.log("Seeded platform_owner:");
    console.log(`  Email:    ${email}`);
    console.log(`  Password: ${password}`);
    console.log(`  TOTP secret (add to an authenticator app): ${secretBase32}`);
    console.log("  Recovery codes (shown once, save them):");
    for (const code of verifyResult.recoveryCodes) {
      console.log(`    ${code}`);
    }
  }

  await seedDemoData();
}

// ---------------------------------------------------------------------------
// Phase 5, Item 67 — full demo dataset.
//
// PLAN.md's "Final Documentation & Release Checklist" > "Seed & Demonstration
// Data": "one demo academy with 2 branches, a demo Academy Owner plus one
// account per academy role, ~10 demo students, 2 demo courses/batches with a
// published result set, a handful of recorded payments/expenses, and one
// issued certificate — enough to exercise every screen without manual data
// entry during development or demos." This is the promissory note the
// original Phase 0 comment above left open once these tables existed.
//
// ---------------------------------------------------------------------------
// Mechanism: idempotent direct inserts, not the full action chain
// ---------------------------------------------------------------------------
// `e2e/fixtures/seed-e2e.ts` (Phase 5 Item 65) already faced this exact
// choice and reasoned through it in its own module comment: driving the
// real, permission-gated action chain (registerAcademy ->
// createAcademySubscription -> recordSubscriptionPayment ->
// verifySubscriptionPayment -> approveAcademy -> activateAcademy -> ...)
// would be the highest-fidelity option, but is also high-risk to bolt onto
// a script every developer runs, since it means threading a real
// `AuthContext` and satisfying every intermediate approval/eligibility gate
// correctly for ~20 sequential steps. That fixture chose direct, idempotent
// inserts producing the same *shape* of data those actions would produce
// instead — this seed expansion makes the identical choice, for the
// identical reason, and the same "safely re-runnable" requirement below
// followed the same get-or-create pattern established there.
//
// Every insert here is get-or-create, keyed by stable, deterministic slugs/
// codes/emails (never randomUUID()) — running `npm run seed` repeatedly
// never creates duplicate rows or violates a unique constraint, and never
// touches the platform_owner seeded above or any other pre-existing data
// (this function only ever inserts rows scoped to the one demo academy it
// creates/finds, and only reads — never deletes or updates — anything
// outside that scope).
// ---------------------------------------------------------------------------

const DEMO_ACADEMY_SLUG = "demo-academy";
const DEMO_PLAN_NAME = "Demo Academy Plan";
const DEMO_PASSWORD =
  process.env.SEED_DEMO_PASSWORD ?? "DemoPassw0rd!2026";

const DEMO_ROLE_EMAILS: Record<AcademyRole, string> = {
  academy_owner: process.env.SEED_DEMO_OWNER_EMAIL ?? "demo-owner@example.com",
  academy_admin: process.env.SEED_DEMO_ADMIN_EMAIL ?? "demo-admin@example.com",
  manager: process.env.SEED_DEMO_MANAGER_EMAIL ?? "demo-manager@example.com",
  admissions_officer:
    process.env.SEED_DEMO_ADMISSIONS_EMAIL ?? "demo-admissions@example.com",
  finance_officer:
    process.env.SEED_DEMO_FINANCE_EMAIL ?? "demo-finance@example.com",
  trainer: process.env.SEED_DEMO_TRAINER_EMAIL ?? "demo-trainer@example.com",
};

const DEMO_ROLE_NAMES: Record<AcademyRole, string> = {
  academy_owner: "Demo Owner",
  academy_admin: "Demo Admin",
  manager: "Demo Manager",
  admissions_officer: "Demo Admissions Officer",
  finance_officer: "Demo Finance Officer",
  trainer: "Demo Trainer",
};

async function getOrCreateUser(userEmail: string): Promise<string> {
  const normalized = userEmail.toLowerCase();
  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);
  if (existingUser) return existingUser.id;

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const [created] = await db
    .insert(users)
    .values({ email: normalized, passwordHash })
    .returning({ id: users.id });
  return created.id;
}

async function getOrCreatePlan(): Promise<string> {
  const [existingPlan] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.name, DEMO_PLAN_NAME))
    .limit(1);
  if (existingPlan) return existingPlan.id;

  const [created] = await db
    .insert(subscriptionPlans)
    .values({
      name: DEMO_PLAN_NAME,
      description: "Seed-only demo plan — never assigned to a real academy.",
      priceAmountCents: 9900,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 5,
      maxStudents: 100,
      maxStaff: 20,
      maxCourses: 20,
      maxStorageBytes: 5_368_709_120,
      smsEnabled: true,
      emailEnabled: true,
      certificateEnabled: true,
      reportsLevel: "advanced",
    })
    .returning({ id: subscriptionPlans.id });
  return created.id;
}

async function getOrCreateAcademy(creatorUserId: string): Promise<string> {
  const [existingAcademy] = await db
    .select({ id: academies.id })
    .from(academies)
    .where(eq(academies.slug, DEMO_ACADEMY_SLUG))
    .limit(1);
  if (existingAcademy) return existingAcademy.id;

  const [created] = await db
    .insert(academies)
    .values({
      name: "Demo Academy",
      slug: DEMO_ACADEMY_SLUG,
      defaultCurrency: "USD",
      type: "Training Institute",
      address: "1 Demo Street, Demo City",
      phone: "+1-555-0100",
      email: "info@demo-academy.example.com",
      website: "https://demo-academy.example.com",
      primaryContactName: DEMO_ROLE_NAMES.academy_owner,
      primaryContactPhone: "+1-555-0101",
      createdBy: creatorUserId,
      approvedBy: creatorUserId,
      approvedAt: new Date(),
    })
    .returning({ id: academies.id });
  return created.id;
}

async function getOrCreateBranch(
  academyId: string,
  name: string,
  code: string,
): Promise<string> {
  const [existingBranch] = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.academyId, academyId), eq(branches.code, code)))
    .limit(1);
  if (existingBranch) return existingBranch.id;

  const [created] = await db
    .insert(branches)
    .values({ academyId, name, code, address: `${name}, Demo City`, phone: "+1-555-0102" })
    .returning({ id: branches.id });
  return created.id;
}

async function ensureMembership(
  userId: string,
  academyId: string,
  role: AcademyRole,
): Promise<void> {
  const [existingMembership] = await db
    .select({ id: academyMemberships.id })
    .from(academyMemberships)
    .where(
      and(eq(academyMemberships.userId, userId), eq(academyMemberships.academyId, academyId)),
    )
    .limit(1);
  if (existingMembership) return;

  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
}

async function ensureSubscription(
  academyId: string,
  planId: string,
  creatorUserId: string,
): Promise<void> {
  const [existingSubscription] = await db
    .select({ id: academySubscriptions.id })
    .from(academySubscriptions)
    .where(eq(academySubscriptions.academyId, academyId))
    .limit(1);
  if (existingSubscription) return;

  await db.insert(academySubscriptions).values({
    academyId,
    planId,
    status: "active",
    endsAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    createdBy: creatorUserId,
  });
}

async function getOrCreateStaffProfile(
  academyId: string,
  userId: string,
  role: AcademyRole,
  branchId: string,
): Promise<string> {
  const [existingProfile] = await db
    .select({ id: staffProfiles.id })
    .from(staffProfiles)
    .where(and(eq(staffProfiles.academyId, academyId), eq(staffProfiles.userId, userId)))
    .limit(1);

  const staffProfileId = existingProfile
    ? existingProfile.id
    : (
        await db
          .insert(staffProfiles)
          .values({
            academyId,
            userId,
            fullName: DEMO_ROLE_NAMES[role],
            phone: "+1-555-0200",
            email: DEMO_ROLE_EMAILS[role],
          })
          .returning({ id: staffProfiles.id })
      )[0].id;

  const [existingAssignment] = await db
    .select({ id: staffBranchAssignments.id })
    .from(staffBranchAssignments)
    .where(
      and(
        eq(staffBranchAssignments.staffProfileId, staffProfileId),
        eq(staffBranchAssignments.branchId, branchId),
      ),
    )
    .limit(1);
  if (!existingAssignment) {
    await db.insert(staffBranchAssignments).values({ academyId, staffProfileId, branchId });
  }

  return staffProfileId;
}

async function getOrCreateProgram(academyId: string): Promise<string> {
  const name = "Web Development";
  const [existingProgram] = await db
    .select({ id: programs.id })
    .from(programs)
    .where(and(eq(programs.academyId, academyId), eq(programs.name, name)))
    .limit(1);
  if (existingProgram) return existingProgram.id;

  const [created] = await db
    .insert(programs)
    .values({ academyId, name, description: "Seed demo program." })
    .returning({ id: programs.id });
  return created.id;
}

async function getOrCreateCourse(
  academyId: string,
  programId: string,
  name: string,
  code: string,
): Promise<string> {
  const [existingCourse] = await db
    .select({ id: courses.id })
    .from(courses)
    .where(and(eq(courses.academyId, academyId), eq(courses.name, name)))
    .limit(1);
  if (existingCourse) return existingCourse.id;

  const [created] = await db
    .insert(courses)
    .values({ academyId, programId, name, code, durationWeeks: 12 })
    .returning({ id: courses.id });
  return created.id;
}

async function getOrCreateBatch(
  academyId: string,
  branchId: string,
  courseId: string,
  name: string,
  code: string,
): Promise<string> {
  const [existingBatch] = await db
    .select({ id: batches.id })
    .from(batches)
    .where(and(eq(batches.academyId, academyId), eq(batches.code, code)))
    .limit(1);
  if (existingBatch) return existingBatch.id;

  const [created] = await db
    .insert(batches)
    .values({
      academyId,
      branchId,
      courseId,
      name,
      code,
      startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      endDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      status: "completed",
    })
    .returning({ id: batches.id });
  return created.id;
}

async function ensureBatchTrainerAssignment(
  academyId: string,
  batchId: string,
  staffProfileId: string,
): Promise<void> {
  const [existingAssignment] = await db
    .select({ id: batchTrainerAssignments.id })
    .from(batchTrainerAssignments)
    .where(
      and(
        eq(batchTrainerAssignments.batchId, batchId),
        eq(batchTrainerAssignments.staffProfileId, staffProfileId),
      ),
    )
    .limit(1);
  if (existingAssignment) return;

  await db.insert(batchTrainerAssignments).values({ academyId, batchId, staffProfileId });
}

async function getOrCreateStudent(
  academyId: string,
  branchId: string,
  studentNumber: string,
  fullName: string,
  creatorUserId: string,
): Promise<string> {
  const [existingStudent] = await db
    .select({ id: students.id })
    .from(students)
    .where(and(eq(students.academyId, academyId), eq(students.studentNumber, studentNumber)))
    .limit(1);
  if (existingStudent) return existingStudent.id;

  const [created] = await db
    .insert(students)
    .values({
      academyId,
      branchId,
      studentNumber,
      fullName,
      phone: "+1-555-0300",
      guardianName: `${fullName}'s Guardian`,
      guardianPhone: "+1-555-0301",
      createdBy: creatorUserId,
    })
    .returning({ id: students.id });
  return created.id;
}

async function ensureBatchEnrollment(
  academyId: string,
  batchId: string,
  studentId: string,
): Promise<void> {
  const [existingEnrollment] = await db
    .select({ id: batchEnrollments.id })
    .from(batchEnrollments)
    .where(and(eq(batchEnrollments.batchId, batchId), eq(batchEnrollments.studentId, studentId)))
    .limit(1);
  if (existingEnrollment) return;

  await db.insert(batchEnrollments).values({
    academyId,
    batchId,
    studentId,
    status: "completed",
  });
}

async function getOrCreateGradeConfiguration(
  academyId: string,
  creatorUserId: string,
): Promise<string> {
  const name = "Demo Standard Grading";
  const [existingConfig] = await db
    .select({ id: gradeConfigurations.id })
    .from(gradeConfigurations)
    .where(and(eq(gradeConfigurations.academyId, academyId), eq(gradeConfigurations.name, name)))
    .limit(1);
  if (existingConfig) return existingConfig.id;

  const [created] = await db
    .insert(gradeConfigurations)
    .values({
      academyId,
      name,
      status: "active",
      createdBy: creatorUserId,
      approvedBy: creatorUserId,
      approvedAt: new Date(),
      activatedAt: new Date(),
    })
    .returning({ id: gradeConfigurations.id });

  await db.insert(gradeBands).values([
    { gradeConfigurationId: created.id, label: "Pass", minMark: "50", maxMark: "100", isPass: true },
    { gradeConfigurationId: created.id, label: "Fail", minMark: "0", maxMark: "49", isPass: false },
  ]);

  return created.id;
}

async function getOrCreateExam(
  academyId: string,
  batchId: string,
  name: string,
): Promise<string> {
  const [existingExam] = await db
    .select({ id: exams.id })
    .from(exams)
    .where(and(eq(exams.academyId, academyId), eq(exams.batchId, batchId), eq(exams.name, name)))
    .limit(1);
  if (existingExam) return existingExam.id;

  const [created] = await db
    .insert(exams)
    .values({
      academyId,
      batchId,
      name,
      maxMarks: "100",
      examDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      status: "completed",
    })
    .returning({ id: exams.id });
  return created.id;
}

async function ensurePublishedExamResult(
  academyId: string,
  examId: string,
  studentId: string,
  batchId: string,
  gradeConfigurationId: string,
  marksObtained: number,
  enteredBy: string,
): Promise<void> {
  const [existingResult] = await db
    .select({ id: examResults.id })
    .from(examResults)
    .where(and(eq(examResults.examId, examId), eq(examResults.studentId, studentId)))
    .limit(1);
  if (existingResult) return;

  const passFail = marksObtained >= 50 ? "pass" : "fail";
  const gradeBandLabel = passFail === "pass" ? "Pass" : "Fail";
  const now = new Date();

  await db.insert(examResults).values({
    academyId,
    examId,
    studentId,
    batchId,
    marksObtained: String(marksObtained),
    gradeConfigurationId,
    gradeBandLabel,
    passFail,
    status: "published",
    enteredBy,
    submittedAt: now,
    approvedBy: enteredBy,
    approvedAt: now,
    publishedAt: now,
  });
}

async function ensureStudentCharge(
  academyId: string,
  studentId: string,
  description: string,
  amountCents: number,
  status: "open" | "partially_paid" | "paid",
  creatorUserId: string,
): Promise<string> {
  const [existingCharge] = await db
    .select({ id: studentCharges.id })
    .from(studentCharges)
    .where(and(eq(studentCharges.studentId, studentId), eq(studentCharges.description, description)))
    .limit(1);
  if (existingCharge) return existingCharge.id;

  const [created] = await db
    .insert(studentCharges)
    .values({
      academyId,
      studentId,
      description,
      amountCents,
      currency: "USD",
      status,
      createdBy: creatorUserId,
    })
    .returning({ id: studentCharges.id });
  return created.id;
}

async function ensureStudentPayment(
  academyId: string,
  studentId: string,
  chargeId: string,
  amountCents: number,
  recordedBy: string,
): Promise<void> {
  const [existingPayment] = await db
    .select({ id: studentPayments.id })
    .from(studentPayments)
    .where(and(eq(studentPayments.chargeId, chargeId), eq(studentPayments.studentId, studentId)))
    .limit(1);
  if (existingPayment) return;

  const now = new Date();
  await db.insert(studentPayments).values({
    academyId,
    studentId,
    chargeId,
    amountCents,
    currency: "USD",
    method: "cash",
    reference: "SEED-DEMO",
    receivedAt: now,
    recordedBy,
    status: "approved",
    approvedBy: recordedBy,
    approvedAt: now,
  });
}

async function ensureIncomeRecord(
  academyId: string,
  category: string,
  amountCents: number,
  recordedBy: string,
): Promise<void> {
  const [existingRecord] = await db
    .select({ id: incomeRecords.id })
    .from(incomeRecords)
    .where(and(eq(incomeRecords.academyId, academyId), eq(incomeRecords.category, category)))
    .limit(1);
  if (existingRecord) return;

  await db.insert(incomeRecords).values({
    academyId,
    category,
    description: `${category} (seed demo data)`,
    amountCents,
    currency: "USD",
    recordedBy,
  });
}

async function ensureExpenseRecord(
  academyId: string,
  category: string,
  amountCents: number,
  submittedBy: string,
): Promise<void> {
  const [existingRecord] = await db
    .select({ id: expenseRecords.id })
    .from(expenseRecords)
    .where(and(eq(expenseRecords.academyId, academyId), eq(expenseRecords.category, category)))
    .limit(1);
  if (existingRecord) return;

  const now = new Date();
  await db.insert(expenseRecords).values({
    academyId,
    category,
    description: `${category} (seed demo data)`,
    amountCents,
    currency: "USD",
    submittedBy,
    status: "approved",
    approvedBy: submittedBy,
    approvedAt: now,
  });
}

async function ensureCertificate(
  academyId: string,
  studentId: string,
  batchId: string,
  issuedBy: string,
): Promise<void> {
  const [existingCertificate] = await db
    .select({ id: certificates.id })
    .from(certificates)
    .where(and(eq(certificates.studentId, studentId), eq(certificates.batchId, batchId)))
    .limit(1);
  if (existingCertificate) return;

  await db.insert(certificates).values({
    academyId,
    studentId,
    batchId,
    certificateCode: "DEMO0-SEED-0001-CERT",
    issuedBy,
  });
}

async function seedDemoData(): Promise<void> {
  const ownerUserId = await getOrCreateUser(DEMO_ROLE_EMAILS.academy_owner);
  const academyId = await getOrCreateAcademy(ownerUserId);
  await ensureMembership(ownerUserId, academyId, "academy_owner");

  const planId = await getOrCreatePlan();
  await ensureSubscription(academyId, planId, ownerUserId);

  const mainBranchId = await getOrCreateBranch(academyId, "Main Campus", "MAIN");
  const northBranchId = await getOrCreateBranch(academyId, "North Campus", "NORTH");

  // One account per remaining academy role (owner is seeded above), all
  // assigned to the Main Campus branch.
  const roleUserIds: Record<AcademyRole, string> = { academy_owner: ownerUserId } as Record<
    AcademyRole,
    string
  >;
  for (const role of [
    "academy_admin",
    "manager",
    "admissions_officer",
    "finance_officer",
    "trainer",
  ] as const) {
    const userId = await getOrCreateUser(DEMO_ROLE_EMAILS[role]);
    await ensureMembership(userId, academyId, role);
    await getOrCreateStaffProfile(academyId, userId, role, mainBranchId);
    roleUserIds[role] = userId;
  }
  const trainerStaffProfileId = await getOrCreateStaffProfile(
    academyId,
    roleUserIds.trainer,
    "trainer",
    mainBranchId,
  );

  const programId = await getOrCreateProgram(academyId);
  const frontendCourseId = await getOrCreateCourse(
    academyId,
    programId,
    "Frontend Development",
    "WD-FE",
  );
  const backendCourseId = await getOrCreateCourse(
    academyId,
    programId,
    "Backend Development",
    "WD-BE",
  );
  const batchAId = await getOrCreateBatch(
    academyId,
    mainBranchId,
    frontendCourseId,
    "Frontend Cohort 1",
    "WD-FE-C1",
  );
  const batchBId = await getOrCreateBatch(
    academyId,
    northBranchId,
    backendCourseId,
    "Backend Cohort 1",
    "WD-BE-C1",
  );
  await ensureBatchTrainerAssignment(academyId, batchAId, trainerStaffProfileId);
  await ensureBatchTrainerAssignment(academyId, batchBId, trainerStaffProfileId);

  const gradeConfigurationId = await getOrCreateGradeConfiguration(academyId, ownerUserId);
  const examAId = await getOrCreateExam(academyId, batchAId, "Final Assessment");
  const examBId = await getOrCreateExam(academyId, batchBId, "Final Assessment");

  // ~10 students, split across the two batches/branches. Marks are chosen
  // so most students pass (matching "a published result set" realistically)
  // while a couple fail, and student #1 (batch A) is the one certificate
  // recipient below.
  const studentMarks = [78, 65, 92, 45, 88, 55, 30, 71, 60, 83];
  const studentIds: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const num = String(i + 1).padStart(4, "0");
    const inBatchA = i < 5;
    const branchId = inBatchA ? mainBranchId : northBranchId;
    const batchId = inBatchA ? batchAId : batchBId;
    const examId = inBatchA ? examAId : examBId;

    const studentId = await getOrCreateStudent(
      academyId,
      branchId,
      `DEMO-${num}`,
      `Demo Student ${i + 1}`,
      ownerUserId,
    );
    studentIds.push(studentId);
    await ensureBatchEnrollment(academyId, batchId, studentId);
    await ensurePublishedExamResult(
      academyId,
      examId,
      studentId,
      batchId,
      gradeConfigurationId,
      studentMarks[i],
      roleUserIds.trainer,
    );
  }

  // A handful of charges/payments/income/expenses — not exhaustive, per
  // PLAN.md's own "a handful" wording.
  for (let i = 0; i < 4; i += 1) {
    const studentId = studentIds[i];
    const chargeStatus = i < 2 ? "paid" : i === 2 ? "partially_paid" : "open";
    const chargeId = await ensureStudentCharge(
      academyId,
      studentId,
      "Tuition Fee — Term 1",
      50000,
      chargeStatus,
      roleUserIds.finance_officer,
    );
    if (chargeStatus !== "open") {
      const paidAmount = chargeStatus === "paid" ? 50000 : 25000;
      await ensureStudentPayment(academyId, studentId, chargeId, paidAmount, roleUserIds.finance_officer);
    }
  }

  await ensureIncomeRecord(academyId, "Registration Fees", 30000, roleUserIds.finance_officer);
  await ensureIncomeRecord(academyId, "Facility Rental Income", 15000, roleUserIds.finance_officer);
  await ensureExpenseRecord(academyId, "Staff Salaries", 200000, roleUserIds.finance_officer);
  await ensureExpenseRecord(academyId, "Utilities", 8000, roleUserIds.manager);

  // One issued certificate — student #1, batch A (marks 78, a Pass).
  await ensureCertificate(academyId, studentIds[0], batchAId, ownerUserId);

  console.log("Seeded demo academy dataset:");
  console.log(`  Academy:  Demo Academy (slug: ${DEMO_ACADEMY_SLUG})`);
  console.log(`  Demo password (all demo accounts, override via SEED_DEMO_PASSWORD): ${DEMO_PASSWORD}`);
  for (const role of Object.keys(DEMO_ROLE_EMAILS) as AcademyRole[]) {
    console.log(`  ${role}: ${DEMO_ROLE_EMAILS[role]}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
