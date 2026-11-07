/**
 * SEC-M-06 (migration 0046): duplicate-submission protection for
 * student_payments, income_records, expense_records and book_sales.
 *
 * Runs against TEST_DATABASE_URL. Every academy, user and row created here
 * is removed in afterAll. "Concurrent" cases fire identical requests with
 * Promise.all, so they really race on the database: each uses its own
 * pooled connection and transaction.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// createBook verifies the uploaded cover in object storage. No storage is
// reached here: same mock as lib/academies/book-sales.test.ts.
vi.mock("@/lib/storage/client", () => ({
  sumObjectSizesByPrefix: vi.fn(async () => ({ ok: true as const, totalBytes: 0 })),
  getUploadUrl: vi.fn(),
  deleteObject: vi.fn(),
  getDownloadUrl: vi.fn(),
  headObject: vi.fn(),
  getObjectPrefix: vi.fn(),
}));
import { getObjectPrefix, headObject } from "@/lib/storage/client";
import { VALID_SIGNATURE_BYTES } from "@/lib/storage/test-signature-fixtures";
beforeEach(() => {
  vi.mocked(headObject).mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });
  vi.mocked(getObjectPrefix).mockResolvedValue({ ok: true, exists: true, bytes: VALID_SIGNATURE_BYTES["image/png"] });
});

import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  batchCourses,
  batchEnrollments,
  batches,
  bookSalePayments,
  bookSales,
  books,
  branches,
  courses,
  enrollmentFeeSchedules,
  expenseRecords,
  feePeriods,
  incomeRecords,
  paymentAllocations,
  programs,
  studentCharges,
  studentPayments,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { courseOfBatch } from "@/lib/academies/test-batch-course";
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";
import { getBookCoverKey } from "@/lib/storage/keys";
import { createBook } from "./books";
import { createBookSale } from "./book-sales";
import { createExpenseRecord } from "./expense-records";
import { listFeePeriodsForEnrollment, recordEnrollmentPayment, recordFeePeriodPayment, setEnrollmentFeeSchedule } from "./fee-periods";
import { IDEMPOTENCY_INDEX, isIdempotencyViolation } from "./idempotency";
import { createIncomeRecord } from "./income-records";
import { createStudentCharge, recordStudentPayment } from "./student-payments";

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `finance-idempotency-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
    .returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      isActive: false,
      description: "Automated test fixture (lib/academies/finance-idempotency.test.ts)",
      name: `Finance Idempotency Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 5,
      maxStudents: 100,
      maxStaff: 10,
      maxCourses: 10,
      maxStorageBytes: 1_073_741_824,
      reportsLevel: "basic",
    })
    .returning({ id: subscriptionPlans.id });
  createdPlanIds.push(plan.id);
  return plan.id;
}

interface Fixture {
  academyId: string;
  branchId: string;
  studentId: string;
  enrollmentId: string;
  manager: AuthContext;
}

/** An academy with a subscription, a branch, a student enrolled in a batch,
 * and an academy-wide manager. */
async function setupFixture(): Promise<Fixture> {
  const [creatorUserId, planId] = await Promise.all([createUser(), createPlan()]);
  const [academy] = await db
    .insert(academies)
    .values({ name: `Finance Idempotency Academy ${randomUUID()}`, slug: `fin-idem-${randomUUID()}`, defaultCurrency: "USD", createdBy: creatorUserId })
    .returning({ id: academies.id });
  const academyId = academy.id;
  createdAcademyIds.push(academyId);

  const [[branch], [program]] = await Promise.all([
    db.insert(branches).values({ academyId, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` }).returning({ id: branches.id }),
    db.insert(programs).values({ academyId, name: `Program ${randomUUID()}` }).returning({ id: programs.id }),
    db.insert(academySubscriptions).values({ academyId, planId, status: "active", endsAt: new Date(Date.now() + 30 * 86_400_000), createdBy: creatorUserId }),
  ]);
  const [course] = await db.insert(courses).values({ academyId, programId: program.id, name: `Course ${randomUUID()}` }).returning({ id: courses.id });
  const [[student], [batch]] = await Promise.all([
    db
      .insert(students)
      .values({ academyId, branchId: branch.id, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "Idempotency Student", createdBy: creatorUserId })
      .returning({ id: students.id }),
    db
      .insert(batches)
      .values({ academyId, branchId: branch.id, courseId: course.id, name: `Batch ${randomUUID()}`, code: `B-${randomUUID().slice(0, 8)}`, startDate: "2026-01-01" })
      .returning({ id: batches.id }),
  ]);
  const [enrollment] = await db
    .insert(batchEnrollments)
    .values({ academyId, batchId: batch.id, courseId: await courseOfBatch(batch.id), studentId: student.id })
    .returning({ id: batchEnrollments.id });

  const manager = await addActingUser(academyId, "manager");
  return { academyId, branchId: branch.id, studentId: student.id, enrollmentId: enrollment.id, manager };
}

async function addActingUser(academyId: string, role: AcademyRole, academyWide = legacyAllBranchAccess(role)): Promise<AuthContext> {
  const userId = await createUser();
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active", academyWide });
  return { userId, branchIds: [], academyWide: false };
}

const auditCount = async (entityId: string, action: string) =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(and(eq(auditLogs.entityId, entityId), eq(auditLogs.action, action))))[0].n;

const keyedRows = async (table: typeof studentPayments | typeof incomeRecords | typeof expenseRecords | typeof bookSales, key: string) =>
  db.select({ id: table.id, academyId: table.academyId }).from(table).where(eq(table.idempotencyKey, key));

afterAll(async () => {
  if (createdAcademyIds.length > 0) {
    await db.delete(auditLogs).where(or(inArray(auditLogs.academyId, createdAcademyIds), inArray(auditLogs.actorUserId, createdUserIds)));
    const academyIn = (column: Parameters<typeof inArray>[0]) => inArray(column, createdAcademyIds);
    await db.delete(bookSalePayments).where(academyIn(bookSalePayments.academyId));
    await db.delete(bookSales).where(academyIn(bookSales.academyId));
    await db.delete(books).where(academyIn(books.academyId));
    await db.delete(paymentAllocations).where(academyIn(paymentAllocations.academyId));
    await db.delete(studentPayments).where(academyIn(studentPayments.academyId));
    await db.delete(studentCharges).where(academyIn(studentCharges.academyId));
    await db.delete(feePeriods).where(academyIn(feePeriods.academyId));
    await db.delete(enrollmentFeeSchedules).where(academyIn(enrollmentFeeSchedules.academyId));
    await db.delete(incomeRecords).where(academyIn(incomeRecords.academyId));
    await db.delete(expenseRecords).where(academyIn(expenseRecords.academyId));
    await db.delete(batchEnrollments).where(academyIn(batchEnrollments.academyId));
    await db.delete(batchCourses).where(academyIn(batchCourses.academyId));
    await db.delete(batches).where(academyIn(batches.academyId));
    await db.delete(courses).where(academyIn(courses.academyId));
    await db.delete(programs).where(academyIn(programs.academyId));
    await db.delete(students).where(academyIn(students.academyId));
    await db.delete(branches).where(academyIn(branches.academyId));
    await db.delete(academySubscriptions).where(academyIn(academySubscriptions.academyId));
    await db.delete(academyMemberships).where(academyIn(academyMemberships.academyId));
    await db.delete(academies).where(inArray(academies.id, createdAcademyIds));
  }
  if (createdPlanIds.length) await db.delete(subscriptionPlans).where(inArray(subscriptionPlans.id, createdPlanIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
}, 300_000);

const RECEIVED = "2026-11-01T10:00:00.000Z";

describe("student payment against a charge", { timeout: 180_000 }, () => {
  async function chargeFixture(amountCents = 10_000) {
    const f = await setupFixture();
    const charge = await createStudentCharge(f.manager, { studentId: f.studentId, description: "Uniform", amountCents });
    if (!charge.ok) throw new Error("charge setup failed");
    return { ...f, chargeId: charge.charge.id };
  }
  const payment = (f: { studentId: string; chargeId: string }, key?: string, amountCents = 4_000) => ({
    studentId: f.studentId,
    chargeId: f.chargeId,
    amountCents,
    method: "cash" as const,
    receivedAt: RECEIVED,
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });

  it("a normal submission records once and stores the key", async () => {
    const f = await chargeFixture();
    const key = randomUUID();
    const result = await recordStudentPayment(f.manager, payment(f, key));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.duplicate).toBeFalsy();
    expect(await keyedRows(studentPayments, key)).toEqual([{ id: result.payment.id, academyId: f.academyId }]);
  });

  it("a repeated request (double click, retry) returns the original payment and writes nothing new", async () => {
    const f = await chargeFixture();
    const key = randomUUID();
    const first = await recordStudentPayment(f.manager, payment(f, key));
    const again = await recordStudentPayment(f.manager, payment(f, key));
    const third = await recordStudentPayment(f.manager, payment(f, key));
    if (!first.ok || !again.ok || !third.ok) throw new Error("expected ok");
    expect(again).toMatchObject({ duplicate: true, payment: { id: first.payment.id } });
    expect(third.payment.id).toBe(first.payment.id);
    expect(await keyedRows(studentPayments, key)).toHaveLength(1);
    expect(await auditCount(first.payment.id, "recordStudentPayment")).toBe(1);
    const [charge] = await db.select({ status: studentCharges.status }).from(studentCharges).where(eq(studentCharges.id, f.chargeId));
    expect(charge.status).toBe("partially_paid");
  });

  it("concurrent identical requests create exactly one payment and one audit row", async () => {
    const f = await chargeFixture();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => recordStudentPayment(f.manager, payment(f, key))));
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = new Set(results.map((r) => (r.ok ? r.payment.id : null)));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
    const rows = await db.select().from(studentPayments).where(eq(studentPayments.chargeId, f.chargeId));
    expect(rows).toHaveLength(1);
    expect(await auditCount(rows[0].id, "recordStudentPayment")).toBe(1);
  });

  it("the same key with different details is refused, not applied", async () => {
    const f = await chargeFixture();
    const key = randomUUID();
    await recordStudentPayment(f.manager, payment(f, key, 4_000));
    const changed = await recordStudentPayment(f.manager, payment(f, key, 5_000));
    expect(changed).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await keyedRows(studentPayments, key)).toHaveLength(1);
  });

  it("an invalid key is rejected before anything is written; no key behaves as before", async () => {
    const f = await chargeFixture();
    const invalid = await recordStudentPayment(f.manager, payment(f, "not-a-uuid"));
    expect(invalid).toMatchObject({ ok: false, error: { code: "validation" } });
    const a = await recordStudentPayment(f.manager, payment(f, undefined, 1_000));
    const b = await recordStudentPayment(f.manager, payment(f, undefined, 1_000));
    expect(a.ok && b.ok).toBe(true);
    const rows = await db.select().from(studentPayments).where(eq(studentPayments.chargeId, f.chargeId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.idempotencyKey === null)).toBe(true);
  });

  it("authorization still applies on a replay: a view-only role and an out-of-scope manager get nothing back", async () => {
    const f = await chargeFixture();
    const key = randomUUID();
    const first = await recordStudentPayment(f.manager, payment(f, key));
    if (!first.ok) throw new Error("expected ok");

    const trainer = await addActingUser(f.academyId, "trainer");
    expect(await recordStudentPayment(trainer, payment(f, key))).toMatchObject({ ok: false, error: { code: "forbidden" } });

    // A manager limited to branches (none assigned here): the student is outside their scope.
    const limited = await addActingUser(f.academyId, "manager", false);
    const replay = await recordStudentPayment(limited, payment(f, key));
    expect(replay.ok).toBe(false);
    expect(JSON.stringify(replay)).not.toContain(first.payment.id);
  });

  it("keys are per academy: another academy reusing the key gets its own record, and never the first academy's", async () => {
    const a = await chargeFixture();
    const b = await chargeFixture();
    const key = randomUUID();
    const inA = await recordStudentPayment(a.manager, payment(a, key));
    const inB = await recordStudentPayment(b.manager, payment(b, key));
    if (!inA.ok || !inB.ok) throw new Error("expected ok");
    expect(inB.payment.id).not.toBe(inA.payment.id);
    expect(inB.duplicate).toBeFalsy();
    // Academy B's manager presenting academy A's student and key: refused, nothing leaked.
    const cross = await recordStudentPayment(b.manager, payment(a, key));
    expect(cross.ok).toBe(false);
    expect(JSON.stringify(cross)).not.toContain(inA.payment.id);
    expect((await keyedRows(studentPayments, key)).map((r) => r.academyId).sort()).toEqual([a.academyId, b.academyId].sort());
  });
});

describe("fee-period and enrollment payments", { timeout: 240_000 }, () => {
  async function feeFixture() {
    const f = await setupFixture();
    const schedule = await setEnrollmentFeeSchedule(f.manager, { enrollmentId: f.enrollmentId, intervalMonths: 12, amountCents: 60_000, anchorDate: "2026-01-01" });
    if (!schedule.ok) throw new Error("schedule setup failed");
    return f;
  }
  const paidForEnrollment = async (enrollmentId: string) =>
    Number(
      (
        await db
          .select({ total: sql<string>`coalesce(sum(${paymentAllocations.amountCents}), 0)` })
          .from(paymentAllocations)
          .innerJoin(feePeriods, eq(feePeriods.id, paymentAllocations.feePeriodId))
          .where(eq(feePeriods.enrollmentId, enrollmentId))
      )[0].total,
    );
  const enrollmentPayment = (f: Fixture, key?: string, amountCents = 7_000) => ({
    studentId: f.studentId,
    enrollmentId: f.enrollmentId,
    amountCents,
    method: "cash" as const,
    receivedAt: RECEIVED,
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });

  it("an enrollment payment retried after it committed returns the original, even though the balance has changed", async () => {
    const f = await feeFixture();
    const key = randomUUID();
    const first = await recordEnrollmentPayment(f.manager, enrollmentPayment(f, key));
    const again = await recordEnrollmentPayment(f.manager, enrollmentPayment(f, key));
    if (!first.ok || !again.ok) throw new Error("expected ok");
    expect(again).toMatchObject({ duplicate: true, payment: { id: first.payment.id } });
    expect(first.payment.allocations.length).toBe(2); // 7,000 spans two 5,000 periods
    expect(await paidForEnrollment(f.enrollmentId)).toBe(7_000);
    expect(await auditCount(first.payment.id, "recordFeePeriodPayment")).toBe(1);
  });

  it("concurrent identical enrollment payments apply the money once", async () => {
    const f = await feeFixture();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => recordEnrollmentPayment(f.manager, enrollmentPayment(f, key))));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.payment.id : null))).size).toBe(1);
    expect(await paidForEnrollment(f.enrollmentId)).toBe(7_000);
    expect(await keyedRows(studentPayments, key)).toHaveLength(1);
  });

  it("concurrent identical per-period payments (row-locked balance check) apply the money once", async () => {
    const f = await feeFixture();
    const periods = await listFeePeriodsForEnrollment(f.manager, f.enrollmentId);
    if (!periods.ok) throw new Error("periods");
    const period = periods.periods.find((p) => p.remainingCents >= 5_000)!;
    const key = randomUUID();
    const input = { studentId: f.studentId, enrollmentId: f.enrollmentId, allocations: [{ feePeriodId: period.id, amountCents: 5_000 }], method: "cash" as const, receivedAt: RECEIVED, idempotencyKey: key };
    const results = await Promise.all(Array.from({ length: 4 }, () => recordFeePeriodPayment(f.manager, input)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.payment.id : null))).size).toBe(1);
    expect(await paidForEnrollment(f.enrollmentId)).toBe(5_000);
  });

  it("a key is bound to its operation: a charge-payment key can't be replayed as a fee-period payment, or the reverse", async () => {
    const f = await feeFixture();
    const charge = await createStudentCharge(f.manager, { studentId: f.studentId, description: "Kit", amountCents: 7_000 });
    if (!charge.ok) throw new Error("charge");
    const chargeKey = randomUUID();
    const chargePayment = await recordStudentPayment(f.manager, { studentId: f.studentId, chargeId: charge.charge.id, amountCents: 7_000, method: "cash", receivedAt: RECEIVED, idempotencyKey: chargeKey });
    expect(chargePayment.ok).toBe(true);
    expect(await recordEnrollmentPayment(f.manager, enrollmentPayment(f, chargeKey))).toMatchObject({ ok: false, error: { code: "conflict" } });

    const feeKey = randomUUID();
    expect((await recordEnrollmentPayment(f.manager, enrollmentPayment(f, feeKey))).ok).toBe(true);
    expect(
      await recordStudentPayment(f.manager, { studentId: f.studentId, amountCents: 7_000, method: "cash", receivedAt: RECEIVED, idempotencyKey: feeKey }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await paidForEnrollment(f.enrollmentId)).toBe(7_000);
  });

  it("a replay by a role without payment rights is refused", async () => {
    const f = await feeFixture();
    const key = randomUUID();
    const first = await recordEnrollmentPayment(f.manager, enrollmentPayment(f, key));
    if (!first.ok) throw new Error("expected ok");
    const trainer = await addActingUser(f.academyId, "trainer");
    const replay = await recordEnrollmentPayment(trainer, enrollmentPayment(f, key));
    expect(replay.ok).toBe(false);
    expect(JSON.stringify(replay)).not.toContain(first.payment.id);
  });
});

describe("income and expense records", { timeout: 180_000 }, () => {
  const cases = [
    { name: "income", table: incomeRecords, create: createIncomeRecord, action: "createIncomeRecord" },
    { name: "expense", table: expenseRecords, create: createExpenseRecord, action: "createExpenseRecord" },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: repeat and concurrent submissions record once; changed details are refused; no key still records`, async () => {
      const f = await setupFixture();
      const key = randomUUID();
      const input = { category: "Idempotency test", amountCents: 2_500, idempotencyKey: key };
      const results = await Promise.all(Array.from({ length: 4 }, () => c.create(f.manager, input)));
      const later = await c.create(f.manager, input);
      expect([...results, later].every((r) => r.ok)).toBe(true);
      const ids = new Set([...results, later].map((r) => (r.ok ? r.record.id : null)));
      expect(ids.size).toBe(1);
      expect(later).toMatchObject({ duplicate: true });
      const [id] = [...ids] as string[];
      expect(await keyedRows(c.table, key)).toHaveLength(1);
      expect(await auditCount(id, c.action)).toBe(1);

      expect(await c.create(f.manager, { ...input, amountCents: 9_999 })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await c.create(f.manager, { ...input, idempotencyKey: "nope" })).toMatchObject({ ok: false, error: { code: "validation" } });
      const plain1 = await c.create(f.manager, { category: "No key", amountCents: 100 });
      const plain2 = await c.create(f.manager, { category: "No key", amountCents: 100 });
      expect(plain1.ok && plain2.ok && plain1.record.id !== plain2.record.id).toBe(true);
    });

    it(`${c.name}: keys are per academy, and an out-of-scope replay returns nothing`, async () => {
      const a = await setupFixture();
      const b = await setupFixture();
      const key = randomUUID();
      const inA = await c.create(a.manager, { category: "Shared key", amountCents: 1_000, branchId: a.branchId, idempotencyKey: key });
      const inB = await c.create(b.manager, { category: "Shared key", amountCents: 1_000, branchId: b.branchId, idempotencyKey: key });
      if (!inA.ok || !inB.ok) throw new Error("expected ok");
      expect(inB.record.id).not.toBe(inA.record.id);
      const limited = await addActingUser(a.academyId, "manager", false);
      const replay = await c.create(limited, { category: "Shared key", amountCents: 1_000, branchId: a.branchId, idempotencyKey: key });
      expect(replay.ok).toBe(false);
      expect(JSON.stringify(replay)).not.toContain(inA.record.id);
    });
  }
});

describe("book sales", { timeout: 180_000 }, () => {
  async function bookFixture(stockQuantity: number) {
    const f = await setupFixture();
    const book = await createBook(f.manager, { name: `Book ${randomUUID()}`, priceCents: 1_000, stockQuantity, coverRef: getBookCoverKey({ academyId: f.academyId, extension: "png" }) });
    if (!book.ok) throw new Error("book setup failed: " + JSON.stringify(book.error));
    return { ...f, bookId: book.book.id };
  }
  const sale = (f: { bookId: string; studentId: string }, key: string, quantity = 2) => ({
    bookId: f.bookId,
    buyerType: "student" as const,
    studentId: f.studentId,
    quantity,
    amountPaidCents: 2_000,
    method: "cash" as const,
    idempotencyKey: key,
  });
  const stockOf = async (bookId: string) => (await db.select({ s: books.stockQuantity }).from(books).where(eq(books.id, bookId)))[0].s;

  it("concurrent identical sales sell once: one sale, one stock decrement, one payment and one income record", async () => {
    // Stock 5, quantity 2: the losers wait on the book row lock and then see
    // stock 3, so they must be answered as duplicates, not "only 3 in stock".
    const f = await bookFixture(5);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => createBookSale(f.manager, sale(f, key))));
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = new Set(results.map((r) => (r.ok ? r.sale.id : null)));
    expect(ids.size).toBe(1);
    const [saleId] = [...ids] as string[];
    expect(await stockOf(f.bookId)).toBe(3);
    expect(await db.select().from(bookSalePayments).where(eq(bookSalePayments.bookSaleId, saleId))).toHaveLength(1);
    expect(await db.select().from(incomeRecords).where(and(eq(incomeRecords.academyId, f.academyId), eq(incomeRecords.category, "book_sale")))).toHaveLength(1);
    expect(await auditCount(saleId, "createBookSale")).toBe(1);
  });

  it("a retry after success returns the sale even when the remaining stock could no longer cover it", async () => {
    const f = await bookFixture(2);
    const key = randomUUID();
    const first = await createBookSale(f.manager, sale(f, key));
    const again = await createBookSale(f.manager, sale(f, key));
    if (!first.ok || !again.ok) throw new Error("expected ok");
    expect(again).toMatchObject({ duplicate: true, sale: { id: first.sale.id } });
    expect(await stockOf(f.bookId)).toBe(0);
    expect(await createBookSale(f.manager, sale(f, key, 1))).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("a replay by a role that can't sell is refused", async () => {
    const f = await bookFixture(5);
    const key = randomUUID();
    const first = await createBookSale(f.manager, sale(f, key));
    if (!first.ok) throw new Error("expected ok");
    const trainer = await addActingUser(f.academyId, "trainer");
    const replay = await createBookSale(trainer, sale(f, key));
    expect(replay.ok).toBe(false);
    expect(JSON.stringify(replay)).not.toContain(first.sale.id);
  });
});

describe("database enforcement (migration 0046)", { timeout: 120_000 }, () => {
  it("existing-style rows with NULL keys coexist; a duplicate key in one academy is rejected by the unique index; other academies are unaffected", async () => {
    const a = await setupFixture();
    const b = await setupFixture();
    const row = (academyId: string, key: string | null) => ({ academyId, category: "Direct insert", amountCents: 1, currency: "USD", recordedBy: a.manager.userId, idempotencyKey: key });
    // Any number of NULL keys in one academy.
    await db.insert(incomeRecords).values([row(a.academyId, null), row(a.academyId, null), row(a.academyId, null)]);
    const key = randomUUID();
    await db.insert(incomeRecords).values(row(a.academyId, key));
    const error = await db.insert(incomeRecords).values(row(a.academyId, key)).catch((e: unknown) => e);
    expect(isIdempotencyViolation(error, IDEMPOTENCY_INDEX.incomeRecords)).toBe(true);
    await expect(db.insert(incomeRecords).values(row(b.academyId, key))).resolves.toBeDefined();

    const indexes = await db.execute<{ indexname: string; indexdef: string }>(
      sql`select indexname, indexdef from pg_indexes where indexname in (${sql.join(Object.values(IDEMPOTENCY_INDEX).map((n) => sql`${n}`), sql`, `)})`,
    );
    expect(indexes.rows).toHaveLength(4);
    for (const index of indexes.rows) {
      expect(index.indexdef).toMatch(/UNIQUE INDEX .* \(academy_id, idempotency_key\) WHERE \(idempotency_key IS NOT NULL\)/);
    }
  });
});
