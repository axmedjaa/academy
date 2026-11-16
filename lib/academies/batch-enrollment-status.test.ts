import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batchCourses,
  batchEnrollments,
  batches,
  branches,
  courses,
  enrollmentFeeSchedules,
  feePeriods,
  notifications,
  programs,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";
import { enrollStudentInBatch as enrollAction } from "./batch-assignments-actions";
import { enrollExistingStudent } from "./register-student-actions";
import { enrollStudentInBatch, updateStudentEnrollment } from "./batch-assignments";
import { archiveBatch, createBatch, restoreBatch, updateBatch } from "./batches";

/**
 * Course enrollment only into a Planned or Active batch, enforced on the
 * server for every entry point: the roster's "use server" action
 * (batch-assignments-actions.ts), the student page's Enroll dialog action
 * (register-student-actions.ts enrollExistingStudent) and the shared
 * function they all call (enrollStudentInBatch / updateStudentEnrollment).
 * The server actions are submitted directly with FormData, as a browser (or
 * a crafted request) would; only the signed-in user and Next's cache
 * revalidation are stubbed.
 */

const auth = vi.hoisted(() => ({ current: null as AuthContext | null }));
vi.mock("@/lib/auth/auth-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/auth-context")>()),
  getAuthContext: async () => auth.current,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAN = { intervalMonths: 1, amountCents: 10_000 };
const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `batch-status-enroll-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function addMember(academyId: string, role: AcademyRole): Promise<AuthContext> {
  const userId = await createUser();
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active", academyWide: legacyAllBranchAccess(role) });
  return { userId, branchIds: [], academyWide: false };
}

interface Fixture {
  academyId: string;
  branchId: string;
  courseId: string;
  owner: AuthContext;
}

let f: Fixture;

beforeAll(async () => {
  const creator = await createUser();
  const [academy] = await db
    .insert(academies)
    .values({ name: `Batch Status Enroll ${randomUUID()}`, slug: `batch-status-enroll-${randomUUID()}`, defaultCurrency: "USD", createdBy: creator })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      isActive: false,
      description: "Automated test fixture (lib/academies/batch-enrollment-status.test.ts)",
      name: `Batch Status Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 10,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses: 20,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  createdPlanIds.push(plan.id);
  await db.insert(academySubscriptions).values({ academyId: academy.id, planId: plan.id, status: "active", endsAt: new Date(Date.now() + 30 * DAY_MS), createdBy: creator });
  const owner = await addMember(academy.id, "academy_owner");
  const [branch] = await db
    .insert(branches)
    .values({ academyId: academy.id, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` })
    .returning({ id: branches.id });
  const [program] = await db.insert(programs).values({ academyId: academy.id, name: "Short Courses" }).returning({ id: programs.id });
  const [course] = await db.insert(courses).values({ academyId: academy.id, programId: program.id, name: "Java" }).returning({ id: courses.id });
  f = { academyId: academy.id, branchId: branch.id, courseId: course.id, owner };
}, 180_000);

afterAll(async () => {
  if (createdAcademyIds.length) {
    await db.delete(auditLogs).where(or(inArray(auditLogs.academyId, createdAcademyIds), inArray(auditLogs.actorUserId, createdUserIds)));
    await db.delete(notifications).where(inArray(notifications.academyId, createdAcademyIds));
    await db.delete(feePeriods).where(inArray(feePeriods.academyId, createdAcademyIds));
    await db.delete(enrollmentFeeSchedules).where(inArray(enrollmentFeeSchedules.academyId, createdAcademyIds));
    await db.delete(batchEnrollments).where(inArray(batchEnrollments.academyId, createdAcademyIds));
    await db.delete(students).where(inArray(students.academyId, createdAcademyIds));
    await db.delete(batchCourses).where(inArray(batchCourses.academyId, createdAcademyIds));
    await db.delete(batches).where(inArray(batches.academyId, createdAcademyIds));
    await db.delete(courses).where(inArray(courses.academyId, createdAcademyIds));
    await db.delete(programs).where(inArray(programs.academyId, createdAcademyIds));
    await db.delete(branches).where(inArray(branches.academyId, createdAcademyIds));
    await db.delete(academySubscriptions).where(inArray(academySubscriptions.academyId, createdAcademyIds));
    await db.delete(academyMemberships).where(inArray(academyMemberships.academyId, createdAcademyIds));
    await db.delete(academies).where(inArray(academies.id, createdAcademyIds));
  }
  if (createdPlanIds.length) await db.delete(subscriptionPlans).where(inArray(subscriptionPlans.id, createdPlanIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
}, 300_000);

type Status = "planned" | "active" | "completed" | "archived";

/** A course batch in the given status, set through the real actions. */
async function batchIn(status: Status): Promise<string> {
  const created = await createBatch(f.owner, { branchId: f.branchId, courseIds: [f.courseId], name: `Batch ${randomUUID()}`, code: `B-${randomUUID().slice(0, 8)}` });
  if (!created.ok) throw new Error(created.error.message);
  const b = created.batch;
  if (status === "active" || status === "completed") {
    const set = await updateBatch(f.owner, b.id, { branchId: b.branchId, courseIds: b.courseIds, name: b.name, code: b.code, status });
    if (!set.ok) throw new Error(set.error.message);
  }
  if (status === "archived") await archiveBatch(f.owner, b.id);
  return b.id;
}

async function newStudent(): Promise<string> {
  const [row] = await db
    .insert(students)
    .values({ academyId: f.academyId, branchId: f.branchId, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "Amina", createdBy: f.owner.userId })
    .returning({ id: students.id });
  return row.id;
}

const enrollmentsOf = (batchId: string, studentId: string) =>
  db.select().from(batchEnrollments).where(and(eq(batchEnrollments.batchId, batchId), eq(batchEnrollments.studentId, studentId)));
const academyFeePeriods = async () => (await db.select({ id: feePeriods.id }).from(feePeriods).where(eq(feePeriods.academyId, f.academyId))).length;
const feePeriodsOf = async (batchId: string, studentId: string) => {
  const ids = (await enrollmentsOf(batchId, studentId)).map((e) => e.id);
  return ids.length ? db.select().from(feePeriods).where(inArray(feePeriods.enrollmentId, ids)) : [];
};

/** The roster's Enroll form, submitted straight to its server action. */
function rosterForm(batchId: string, studentId: string): FormData {
  const form = new FormData();
  form.set("batchId", batchId);
  form.set("studentId", studentId);
  form.append("courseIds", f.courseId);
  form.set("paymentPlanIntervalMonths", "1");
  form.set("paymentPlanAmountDollars", "100.00");
  return form;
}

/** The student page's Enroll dialog, submitted straight to its server action. */
function studentPageForm(batchId: string, studentId: string): FormData {
  const form = new FormData();
  form.set("studentId", studentId);
  form.set(
    "enrollment",
    JSON.stringify({ type: "courses", lines: [{ courseId: f.courseId, courseName: "Java", batchId, feeCents: 10_000, discountCents: 0, installments: 1, paidCents: 0 }] }),
  );
  return form;
}

describe("course enrollment follows the batch status (server-side, every entry point)", () => {
  it.each<[Status, boolean]>([
    ["planned", true],
    ["active", true],
    ["completed", false],
    ["archived", false],
  ])("roster server action, %s batch: enrollment allowed = %s", async (status, allowed) => {
    auth.current = f.owner;
    const batchId = await batchIn(status);
    const studentId = await newStudent();
    const periodsBefore = await academyFeePeriods();
    const result = await enrollAction({ ok: false }, rosterForm(batchId, studentId));
    expect(result.ok).toBe(allowed);
    if (!allowed) {
      expect(result.error?.code).toBe("validation");
      expect(result.error?.message).toMatch(status === "archived" ? /archived/ : /completed/);
    }
    expect(await enrollmentsOf(batchId, studentId)).toHaveLength(allowed ? 1 : 0);
    // A refused enrollment leaves no fee schedule behind.
    if (allowed) expect((await feePeriodsOf(batchId, studentId)).length).toBeGreaterThan(0);
    else expect(await academyFeePeriods()).toBe(periodsBefore);
  });

  it.each<[Status, boolean]>([
    ["planned", true],
    ["active", true],
    ["completed", false],
    ["archived", false],
  ])("student page Enroll server action, %s batch: enrollment allowed = %s", async (status, allowed) => {
    auth.current = f.owner;
    const batchId = await batchIn(status);
    const studentId = await newStudent();
    const result = await enrollExistingStudent({ ok: false }, studentPageForm(batchId, studentId));
    expect(result.ok).toBe(allowed);
    if (!allowed) expect(result.error?.message).toMatch(status === "archived" ? /archived/ : /completed/);
    expect(await enrollmentsOf(batchId, studentId)).toHaveLength(allowed ? 1 : 0);
  });

  it("the shared functions (enrollStudentInBatch, updateStudentEnrollment) apply the same rule", async () => {
    for (const [status, allowed] of [["planned", true], ["active", true], ["completed", false], ["archived", false]] as const) {
      const batchId = await batchIn(status);
      const viaFn = await enrollStudentInBatch(f.owner, { batchId, studentId: await newStudent(), paymentPlan: PLAN });
      expect(viaFn.ok).toBe(allowed);
      const viaUpdate = await updateStudentEnrollment(f.owner, await newStudent(), batchId, PLAN);
      expect(viaUpdate.ok).toBe(allowed);
    }
  });

  it("a batch reopened (Completed -> Active, or restored from Archived) takes enrollments again", async () => {
    const completed = await batchIn("completed");
    const studentId = await newStudent();
    expect((await enrollStudentInBatch(f.owner, { batchId: completed, studentId, paymentPlan: PLAN })).ok).toBe(false);
    const [b] = await db.select().from(batches).where(eq(batches.id, completed));
    await updateBatch(f.owner, completed, { branchId: b.branchId, courseIds: [f.courseId], name: b.name, code: b.code, status: "active" });
    expect((await enrollStudentInBatch(f.owner, { batchId: completed, studentId, paymentPlan: PLAN })).ok).toBe(true);

    const archived = await batchIn("archived");
    await restoreBatch(f.owner, archived);
    expect((await enrollStudentInBatch(f.owner, { batchId: archived, studentId: await newStudent(), paymentPlan: PLAN })).ok).toBe(true);
  });

  it("existing rules still apply first: signed out, no permission, duplicate enrollment", async () => {
    const batchId = await batchIn("active");
    const studentId = await newStudent();

    auth.current = null;
    expect((await enrollAction({ ok: false }, rosterForm(batchId, studentId))).error?.code).toBe("forbidden");

    auth.current = await addMember(f.academyId, "admissions_officer");
    const viewer = await enrollAction({ ok: false }, rosterForm(batchId, studentId));
    expect(viewer.ok).toBe(false);
    expect(viewer.error?.code).toBe("forbidden");

    auth.current = f.owner;
    expect((await enrollAction({ ok: false }, rosterForm(batchId, studentId))).ok).toBe(true);
    const again = await enrollAction({ ok: false }, rosterForm(batchId, studentId));
    expect(again.ok).toBe(false);
    expect(again.error?.code).toBe("conflict");
    expect(await enrollmentsOf(batchId, studentId)).toHaveLength(1);
  });

  it("enrollments made before a batch was completed are kept", async () => {
    const batchId = await batchIn("active");
    const studentId = await newStudent();
    expect((await enrollStudentInBatch(f.owner, { batchId, studentId, paymentPlan: PLAN })).ok).toBe(true);
    const [b] = await db.select().from(batches).where(eq(batches.id, batchId));
    await updateBatch(f.owner, batchId, { branchId: b.branchId, courseIds: [f.courseId], name: b.name, code: b.code, status: "completed" });
    const rows = await enrollmentsOf(batchId, studentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect((await feePeriodsOf(batchId, studentId)).length).toBeGreaterThan(0);
  });
});
