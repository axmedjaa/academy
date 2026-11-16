import { randomUUID } from "node:crypto";
import { eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  bookIssues,
  bookOrderItems,
  bookOrderReceipts,
  incomeRecords,
  bookOrderPayments,
  bookOrders,
  books,
  branches,
  expenseRecords,
  notifications,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { legacyAllBranchAccess } from "@/lib/testing/legacy-all-branch-access";
import {
  cancelBookOrder,
  createBookOrder,
  getBookOrdersOverview,
  issueBooksToStudent,
  listStudentBookIssues,
  recordBookOrderPayment,
  updateBookOrderDiscount,
} from "./book-orders";
import { bookOrderPaymentStatus } from "./book-order-math";

/**
 * Book orders (migrations 0051, 0052, 0056): Create Order for a Student or
 * an Other Buyer, order numbers, an optional first payment, the buyer's
 * payments (partial and full, posted as income, never as an expense), and
 * giving books from stock once fully paid. Old supplier rows stay in the
 * database but are never listed or acted on. The remote test database is
 * slow, so each academy fixture is built once and the tests share it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TODAY = new Date().toISOString().slice(0, 10);
const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `book-orders-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" })
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
  owner: AuthContext;
  bookA: string;
  bookB: string;
}

async function setupFixture(): Promise<Fixture> {
  const creator = await createUser();
  const [academy] = await db
    .insert(academies)
    .values({ name: `Book Orders Test ${randomUUID()}`, slug: `book-orders-test-${randomUUID()}`, defaultCurrency: "USD", createdBy: creator })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      isActive: false,
      description: "Automated test fixture (lib/academies/book-orders.test.ts)",
      name: `Book Orders Plan ${randomUUID()}`,
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
  const bookRows = await db
    .insert(books)
    .values([
      { academyId: academy.id, name: "Mathematics 1", priceCents: 800, currency: "USD", stockQuantity: 0, createdBy: owner.userId },
      { academyId: academy.id, name: "English Reader", priceCents: 600, currency: "USD", stockQuantity: 3, createdBy: owner.userId },
    ])
    .returning({ id: books.id });
  return { academyId: academy.id, branchId: branch.id, owner, bookA: bookRows[0].id, bookB: bookRows[1].id };
}

async function newStudent(f: Fixture): Promise<string> {
  const [row] = await db
    .insert(students)
    .values({ academyId: f.academyId, branchId: f.branchId, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "Amina", createdBy: f.owner.userId })
    .returning({ id: students.id });
  return row.id;
}

const setStock = (bookId: string, n: number) => db.update(books).set({ stockQuantity: n }).where(eq(books.id, bookId));
const stockOf = async (bookId: string) => (await db.select({ s: books.stockQuantity }).from(books).where(eq(books.id, bookId)))[0].s;

/** For a student: 10 x Mathematics 1 ($8.00) + 5 x English Reader ($6.00) = $110.00. */
async function order(f: Fixture, extra: Partial<Parameters<typeof createBookOrder>[1]> = {}) {
  const studentId = extra.studentId ?? (extra.buyerType === "other_person" ? undefined : await newStudent(f));
  return createBookOrder(f.owner, {
    buyerType: "student",
    studentId,
    orderDate: TODAY,
    items: [
      { bookId: f.bookA, quantity: 10 },
      { bookId: f.bookB, quantity: 5 },
    ],
    idempotencyKey: randomUUID(),
    ...extra,
  });
}

const pay = (f: Fixture, orderId: string, amountCents: number, idempotencyKey = randomUUID()) =>
  recordBookOrderPayment(f.owner, { orderId, amountCents, method: "cash", reference: "RCPT-1", paidOn: TODAY, idempotencyKey });

let f: Fixture;
let other: Fixture;
beforeAll(async () => {
  f = await setupFixture();
  other = await setupFixture();
}, 180_000);

afterAll(async () => {
  if (createdAcademyIds.length) {
    await db.delete(auditLogs).where(or(inArray(auditLogs.academyId, createdAcademyIds), inArray(auditLogs.actorUserId, createdUserIds)));
    await db.delete(notifications).where(inArray(notifications.academyId, createdAcademyIds));
    await db.delete(bookIssues).where(inArray(bookIssues.academyId, createdAcademyIds));
    await db.delete(bookOrderPayments).where(inArray(bookOrderPayments.academyId, createdAcademyIds));
    await db.delete(incomeRecords).where(inArray(incomeRecords.academyId, createdAcademyIds));
    await db.delete(bookOrderReceipts).where(inArray(bookOrderReceipts.academyId, createdAcademyIds));
    await db.delete(bookOrderItems).where(inArray(bookOrderItems.academyId, createdAcademyIds));
    await db.delete(bookOrders).where(inArray(bookOrders.academyId, createdAcademyIds));
    await db.delete(students).where(inArray(students.academyId, createdAcademyIds));
    await db.delete(books).where(inArray(books.academyId, createdAcademyIds));
    await db.delete(branches).where(inArray(branches.academyId, createdAcademyIds));
    await db.delete(academySubscriptions).where(inArray(academySubscriptions.academyId, createdAcademyIds));
    await db.delete(academyMemberships).where(inArray(academyMemberships.academyId, createdAcademyIds));
    await db.delete(academies).where(inArray(academies.id, createdAcademyIds));
  }
  if (createdPlanIds.length) await db.delete(subscriptionPlans).where(inArray(subscriptionPlans.id, createdPlanIds));
  if (createdUserIds.length) await db.delete(users).where(inArray(users.id, createdUserIds));
}, 300_000);


describe("ordering books (like a sale: a student or another person)", () => {
  it("a student's order: lines at the book prices, the student's branch, replay of a repeated submit", async () => {
    const studentId = await newStudent(f);
    const key = randomUUID();
    const first = await order(f, { studentId, idempotencyKey: key });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.totalCents).toBe(11_000);
    expect(await order(f, { studentId, idempotencyKey: key })).toMatchObject({ ok: true, orderId: first.orderId, duplicate: true });
    const [row] = await db.select().from(bookOrders).where(eq(bookOrders.idempotencyKey, key));
    expect(row).toMatchObject({ buyerType: "student", studentId, branchId: f.branchId, status: "ordered", subtotalCents: 11_000, discountCents: 0, totalCents: 11_000 });
    const items = await db.select().from(bookOrderItems).where(eq(bookOrderItems.orderId, first.orderId));
    expect(items.map((i) => [i.unitCostCents, i.lineTotalCents]).sort((a, b) => a[0] - b[0])).toEqual([
      [600, 3_000],
      [800, 8_000],
    ]);
  });

  it("another person's order with a percentage discount", async () => {
    const created = await order(f, { buyerType: "other_person", buyerName: "Hodan Ali", buyerPhone: "+252 63 111 2222", branchId: f.branchId, discountType: "percentage", discountValue: 10 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.totalCents).toBe(9_900);
    const [row] = await db.select().from(bookOrders).where(eq(bookOrders.id, created.orderId));
    expect(row).toMatchObject({ buyerType: "other_person", studentId: null, buyerName: "Hodan Ali", subtotalCents: 11_000, discountCents: 1_100, totalCents: 9_900 });
  });

  it("rejects bad input: no buyer, no lines, zero quantity, a repeated book, a future date, another academy's book or student", async () => {
    expect((await order(f, { buyerType: "other_person" })).ok).toBe(false);
    expect((await order(f, { items: [] })).ok).toBe(false);
    expect((await order(f, { items: [{ bookId: f.bookA, quantity: 0 }] })).ok).toBe(false);
    expect((await order(f, { items: [{ bookId: f.bookA, quantity: 1 }, { bookId: f.bookA, quantity: 2 }] })).ok).toBe(false);
    expect((await order(f, { orderDate: new Date(Date.now() + 5 * DAY_MS).toISOString().slice(0, 10) })).ok).toBe(false);
    const foreignBook = await order(f, { items: [{ bookId: other.bookA, quantity: 1 }] });
    expect(foreignBook.ok).toBe(false);
    if (!foreignBook.ok) expect(foreignBook.error.code).toBe("not_found");
    const foreignStudent = await order(f, { studentId: await newStudent(other) });
    expect(foreignStudent.ok).toBe(false);
    if (!foreignStudent.ok) expect(foreignStudent.error.code).toBe("not_found");
  });
});

describe("payments from the buyer", () => {
  it("partial then full: unpaid -> partially paid -> fully paid, each posted as income; overpayment and duplicates refused", async () => {
    const created = await order(f);
    if (!created.ok) throw new Error(created.error.message);
    const id = created.orderId;

    const first = await pay(f, id, 4_000);
    expect(first).toMatchObject({ ok: true, paidCents: 4_000, outstandingCents: 7_000, paymentStatus: "partially_paid" });
    expect((await pay(f, id, 7_001)).ok).toBe(false);

    const key = randomUUID();
    expect(await pay(f, id, 7_000, key)).toMatchObject({ ok: true, paidCents: 11_000, outstandingCents: 0, paymentStatus: "paid" });
    expect(await pay(f, id, 7_000, key)).toMatchObject({ ok: true, duplicate: true, paidCents: 11_000 });
    const rows = await db.select().from(bookOrderPayments).where(eq(bookOrderPayments.orderId, id));
    expect(rows).toHaveLength(2);
    expect((await pay(f, id, 100)).ok).toBe(false);

    // One income record per payment, for exactly the amount.
    const income = await db.select().from(incomeRecords).where(inArray(incomeRecords.id, rows.map((r) => r.incomeRecordId!)));
    expect(income.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([4_000, 7_000]);
    expect(income.every((r) => r.category === "book_order" && r.branchId === f.branchId)).toBe(true);

    const overview = await getBookOrdersOverview(f.owner);
    if (!overview.ok) throw new Error(overview.error.message);
    const view = overview.overview.orders.find((o) => o.id === id)!;
    expect(view).toMatchObject({ buyerType: "student", buyerName: "Amina", totalCents: 11_000, paidCents: 11_000, outstandingCents: 0, paymentStatus: "paid" });
    expect(view.payments).toHaveLength(2);
  });

  it("a payment must belong to an existing order of this academy", async () => {
    const missing = await pay(f, randomUUID(), 100);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("not_found");
    const theirs = await order(other);
    if (!theirs.ok) throw new Error(theirs.error.message);
    const foreign = await pay(f, theirs.orderId, 100);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("not_found");
  });

  it("payment status helper", () => {
    expect(bookOrderPaymentStatus(6_000, 0)).toBe("unpaid");
    expect(bookOrderPaymentStatus(6_000, 1)).toBe("partially_paid");
    expect(bookOrderPaymentStatus(6_000, 6_000)).toBe("paid");
  });
});

describe("giving books for a request (fully paid + in stock)", () => {
  it("refuses until fully paid; then gives from stock, never more than requested or in stock; records who gave it", async () => {
    const studentId = await newStudent(f);
    const created = await order(f, { studentId, items: [{ bookId: f.bookA, quantity: 3 }] }); // 3 x $8 = $24
    if (!created.ok) throw new Error(created.error.message);
    const give = (quantity: number, idempotencyKey = randomUUID()) =>
      issueBooksToStudent(f.owner, { orderId: created.orderId, bookId: f.bookA, quantity, issuedOn: TODAY, idempotencyKey });

    await setStock(f.bookA, 2);
    expect((await give(1)).ok).toBe(false); // unpaid
    await pay(f, created.orderId, 1_000);
    const partly = await give(1);
    expect(partly.ok).toBe(false); // partially paid: no exception without approval
    if (!partly.ok) expect(partly.error.message).toMatch(/fully paid/);
    await pay(f, created.orderId, 1_400);

    const key = randomUUID();
    expect(await give(2, key)).toMatchObject({ ok: true, stockLeft: 0 });
    expect(await give(2, key)).toMatchObject({ ok: true, duplicate: true }); // no second hand-over
    expect(await stockOf(f.bookA)).toBe(0);
    expect((await give(1)).ok).toBe(false); // out of stock: never negative
    await setStock(f.bookA, 5);
    expect((await give(2)).ok).toBe(false); // only 1 left on the request
    expect(await give(1)).toMatchObject({ ok: true, stockLeft: 4 });

    const listed = await listStudentBookIssues(f.owner, studentId);
    if (!listed.ok) throw new Error(listed.error.message);
    expect(listed.issues.map((x) => x.quantity).sort()).toEqual([1, 2]);
    expect(listed.issues[0].recipientName).toBe("Amina");
    const [row] = await db.select().from(bookIssues).where(eq(bookIssues.id, listed.issues[0].id));
    expect(row.issuedBy).toBe(f.owner.userId);
  });

  it("a request never changes stock, can't be cancelled once paid, and a cancelled request gives nothing", async () => {
    const a0 = await stockOf(f.bookA);
    const paid = await order(f);
    if (!paid.ok) throw new Error(paid.error.message);
    expect(await stockOf(f.bookA)).toBe(a0);
    await pay(f, paid.orderId, 500);
    expect((await cancelBookOrder(f.owner, paid.orderId)).ok).toBe(false);

    const unpaid = await order(f);
    if (!unpaid.ok) throw new Error(unpaid.error.message);
    expect(await cancelBookOrder(f.owner, unpaid.orderId)).toEqual({ ok: true, status: "cancelled" });
    expect((await pay(f, unpaid.orderId, 100)).ok).toBe(false);
    expect((await issueBooksToStudent(f.owner, { orderId: unpaid.orderId, bookId: f.bookA, quantity: 1, issuedOn: TODAY, idempotencyKey: randomUUID() })).ok).toBe(false);
  });

  it("refuses another academy's request and a member without book rights; overviews never cross academies", async () => {
    const theirs = await order(other);
    if (!theirs.ok) throw new Error(theirs.error.message);
    const foreign = await issueBooksToStudent(f.owner, { orderId: theirs.orderId, bookId: other.bookA, quantity: 1, issuedOn: TODAY, idempotencyKey: randomUUID() });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("not_found");

    const trainer = await addMember(f.academyId, "trainer");
    const studentId = await newStudent(f);
    expect((await createBookOrder(trainer, { buyerType: "student", studentId, orderDate: TODAY, items: [{ bookId: f.bookA, quantity: 1 }], idempotencyKey: randomUUID() })).ok).toBe(false);

    const theirsView = await getBookOrdersOverview(other.owner);
    const ours = await getBookOrdersOverview(f.owner);
    if (!theirsView.ok || !ours.ok) throw new Error("overview");
    const ourIds = new Set([...ours.overview.orders.map((o) => o.id), ...ours.overview.issues.map((x) => x.id)]);
    expect([...theirsView.overview.orders.map((o) => o.id), ...theirsView.overview.issues.map((x) => x.id)].some((id) => ourIds.has(id))).toBe(false);
  });
});

describe("changing an order's discount", () => {
  it("recomputes the total from the subtotal, never below what was paid, and not on a cancelled order", async () => {
    const created = await order(f); // subtotal $110.00
    if (!created.ok) throw new Error(created.error.message);
    const id = created.orderId;

    expect(await updateBookOrderDiscount(f.owner, { orderId: id, discountType: "fixed", discountValue: 1_000 })).toMatchObject({
      ok: true,
      subtotalCents: 11_000,
      discountCents: 1_000,
      totalCents: 10_000,
      outstandingCents: 10_000,
    });
    expect(await updateBookOrderDiscount(f.owner, { orderId: id, discountType: "percentage", discountValue: 20 })).toMatchObject({ ok: true, totalCents: 8_800 });
    expect((await updateBookOrderDiscount(f.owner, { orderId: id, discountType: "percentage", discountValue: 101 })).ok).toBe(false);

    await pay(f, id, 8_000);
    // $8,000 paid: a total of $55.00 (50% off) would be below it.
    const tooLow = await updateBookOrderDiscount(f.owner, { orderId: id, discountType: "percentage", discountValue: 50 });
    expect(tooLow.ok).toBe(false);
    expect(await updateBookOrderDiscount(f.owner, { orderId: id, discountType: "none", discountValue: 0 })).toMatchObject({ ok: true, totalCents: 11_000, outstandingCents: 3_000 });
    const [row] = await db.select().from(bookOrders).where(eq(bookOrders.id, id));
    expect(row).toMatchObject({ discountCents: 0, totalCents: 11_000 });

    const cancelled = await order(f);
    if (!cancelled.ok) throw new Error(cancelled.error.message);
    await cancelBookOrder(f.owner, cancelled.orderId);
    expect((await updateBookOrderDiscount(f.owner, { orderId: cancelled.orderId, discountType: "fixed", discountValue: 100 })).ok).toBe(false);

    const theirs = await order(other);
    if (!theirs.ok) throw new Error(theirs.error.message);
    const foreign = await updateBookOrderDiscount(f.owner, { orderId: theirs.orderId, discountType: "fixed", discountValue: 100 });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.code).toBe("not_found");
  });
});

describe("orders and payments never add stock", () => {
  it("creating, paying in parts and in full, and changing the discount leave stock unchanged; payments post income only", async () => {
    await setStock(f.bookA, 4);
    await setStock(f.bookB, 1);
    const forStudent = await order(f); // 10 x A + 5 x B, more than is in stock
    const forOther = await order(f, { buyerType: "other_person", buyerName: "Walk-in parent", items: [{ bookId: f.bookB, quantity: 2 }] });
    if (!forStudent.ok || !forOther.ok) throw new Error("orders");
    const unchanged = async () => {
      expect(await stockOf(f.bookA)).toBe(4);
      expect(await stockOf(f.bookB)).toBe(1);
    };
    await unchanged();

    expect((await pay(f, forStudent.orderId, 3_000)).ok).toBe(true);
    await unchanged();
    expect((await pay(f, forStudent.orderId, forStudent.totalCents - 3_000)).ok).toBe(true);
    expect((await pay(f, forOther.orderId, forOther.totalCents)).ok).toBe(true);
    await unchanged();
    expect((await updateBookOrderDiscount(f.owner, { orderId: forStudent.orderId, discountType: "none", discountValue: 0 })).ok).toBe(true);
    await unchanged();

    // Fully paid orders still show nothing received: paying is not receiving.
    const items = await db.select().from(bookOrderItems).where(inArray(bookOrderItems.orderId, [forStudent.orderId, forOther.orderId]));
    expect(items.every((item) => item.quantityReceived === 0)).toBe(true);
    expect(await db.select().from(bookOrderReceipts).where(inArray(bookOrderReceipts.orderId, [forStudent.orderId, forOther.orderId]))).toHaveLength(0);
    const income = await db.select().from(incomeRecords).where(eq(incomeRecords.academyId, f.academyId));
    expect(income.filter((row) => row.category === "book_order").length).toBeGreaterThanOrEqual(3);
  });

  it("historical receiving rows on an old order stay readable and keep it from being cancelled", async () => {
    await setStock(f.bookB, 7);
    const created = await order(f, { items: [{ bookId: f.bookB, quantity: 3 }] });
    if (!created.ok) throw new Error(created.error.message);
    const [item] = await db.select().from(bookOrderItems).where(eq(bookOrderItems.orderId, created.orderId));
    // A delivery recorded before Receive Stock moved to supplier orders.
    await db.update(bookOrderItems).set({ quantityReceived: 2 }).where(eq(bookOrderItems.id, item.id));
    await db.insert(bookOrderReceipts).values({
      academyId: f.academyId,
      orderId: created.orderId,
      itemId: item.id,
      bookId: f.bookB,
      quantity: 2,
      receivedOn: TODAY,
      note: "DN-7",
      idempotencyKey: randomUUID(),
      receivedBy: f.owner.userId,
    });

    const overview = await getBookOrdersOverview(f.owner);
    if (!overview.ok) throw new Error(overview.error.message);
    const view = overview.overview.orders.find((o) => o.id === created.orderId)!;
    expect(view).toMatchObject({ copies: 3, receivedCopies: 2 });
    expect(view.receipts).toHaveLength(1);
    expect(view.receipts[0]).toMatchObject({ quantity: 2, note: "DN-7" });
    expect((await cancelBookOrder(f.owner, created.orderId)).ok).toBe(false);
    expect(await stockOf(f.bookB)).toBe(7);
  });
});

describe("unified Create Order: order numbers, Other Buyer details, payment at creation", () => {
  it("numbers orders 1, 2, 3 ... per academy, unique, and a replay keeps its number", async () => {
    const key = randomUUID();
    const a = await order(f, { idempotencyKey: key });
    const b = await order(f);
    if (!a.ok || !b.ok) throw new Error("orders");
    expect(b.orderNumber).toBe(a.orderNumber + 1);
    expect(await order(f, { idempotencyKey: key })).toMatchObject({ ok: true, orderId: a.orderId, orderNumber: a.orderNumber, duplicate: true });
    const rows = await db.select({ n: bookOrders.orderNumber }).from(bookOrders).where(eq(bookOrders.academyId, f.academyId));
    expect(new Set(rows.map((r) => r.n)).size).toBe(rows.length);
    // Concurrent creates in one academy still get distinct numbers.
    const burst = await Promise.all([order(f), order(f), order(f)]);
    const numbers = burst.map((r) => (r.ok ? r.orderNumber : -1));
    expect(new Set(numbers).size).toBe(3);
    expect(numbers.every((n) => n > b.orderNumber)).toBe(true);
  });

  it("an Other Buyer needs only a name; phone and email are optional and kept; no student is created", async () => {
    const studentsBefore = (await db.select({ id: students.id }).from(students).where(eq(students.academyId, f.academyId))).length;
    const full = await order(f, { buyerType: "other_person", buyerName: "Sahra Yusuf", buyerPhone: "+252 63 555 0101", buyerEmail: "Sahra@Example.com", branchId: f.branchId });
    const nameOnly = await order(f, { buyerType: "other_person", buyerName: "Visitor", branchId: f.branchId });
    if (!full.ok || !nameOnly.ok) throw new Error("orders");
    const [row] = await db.select().from(bookOrders).where(eq(bookOrders.id, full.orderId));
    expect(row).toMatchObject({ buyerType: "other_person", studentId: null, buyerName: "Sahra Yusuf", buyerPhone: "+252 63 555 0101", buyerEmail: "sahra@example.com" });
    const [bare] = await db.select().from(bookOrders).where(eq(bookOrders.id, nameOnly.orderId));
    expect(bare).toMatchObject({ buyerName: "Visitor", buyerPhone: null, buyerEmail: null });
    expect((await db.select({ id: students.id }).from(students).where(eq(students.academyId, f.academyId))).length).toBe(studentsBefore);

    expect((await order(f, { buyerType: "other_person", buyerName: "   ", branchId: f.branchId })).ok).toBe(false);
    expect((await order(f, { buyerType: "other_person", buyerName: "X", buyerEmail: "not-an-email", branchId: f.branchId })).ok).toBe(false);

    const overview = await getBookOrdersOverview(f.owner);
    if (!overview.ok) throw new Error(overview.error.message);
    expect(overview.overview.orders.find((o) => o.id === full.orderId)).toMatchObject({ buyerType: "other_person", buyerName: "Sahra Yusuf", buyerEmail: "sahra@example.com", orderNumber: row.orderNumber });
  });

  it("a student order ignores Other Buyer fields and takes the student's branch", async () => {
    const studentId = await newStudent(f);
    const created = await order(f, { studentId, buyerName: "Someone else", buyerEmail: "x@example.com" });
    if (!created.ok) throw new Error(created.error.message);
    const [row] = await db.select().from(bookOrders).where(eq(bookOrders.id, created.orderId));
    expect(row).toMatchObject({ buyerType: "student", studentId, buyerName: null, buyerEmail: null, branchId: f.branchId });
  });

  it("a payment taken at creation is saved with the order as income; overpaying saves nothing; a replay adds no second payment", async () => {
    const key = randomUUID();
    const input = { idempotencyKey: key, payment: { amountCents: 4_000, method: "mobile_money" as const, reference: "MM-1", paidOn: TODAY } };
    const created = await order(f, { buyerType: "other_person", buyerName: "Parent", branchId: f.branchId, ...input });
    expect(created).toMatchObject({ ok: true, totalCents: 11_000, paidCents: 4_000 });
    if (!created.ok) return;
    expect(await order(f, { buyerType: "other_person", buyerName: "Parent", branchId: f.branchId, ...input })).toMatchObject({ ok: true, duplicate: true, paidCents: 4_000 });
    const payments = await db.select().from(bookOrderPayments).where(eq(bookOrderPayments.orderId, created.orderId));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amountCents: 4_000, method: "mobile_money", reference: "MM-1" });
    const [income] = await db.select().from(incomeRecords).where(eq(incomeRecords.id, payments[0].incomeRecordId!));
    expect(income).toMatchObject({ category: "book_order", amountCents: 4_000, branchId: f.branchId });
    expect(await pay(f, created.orderId, 7_000)).toMatchObject({ ok: true, outstandingCents: 0, paymentStatus: "paid" });

    const overKey = randomUUID();
    const over = await order(f, { idempotencyKey: overKey, payment: { amountCents: 11_001, method: "cash", paidOn: TODAY } });
    expect(over.ok).toBe(false);
    expect(await db.select().from(bookOrders).where(eq(bookOrders.idempotencyKey, overKey))).toHaveLength(0);
    expect((await order(f, { payment: { amountCents: 0, method: "cash", paidOn: TODAY } })).ok).toBe(false);
  });

  it("book orders and their payments never create an expense", async () => {
    const before = await db.select({ id: expenseRecords.id }).from(expenseRecords).where(eq(expenseRecords.academyId, f.academyId));
    const created = await order(f, { payment: { amountCents: 1_000, method: "cash", paidOn: TODAY } });
    if (!created.ok) throw new Error(created.error.message);
    await pay(f, created.orderId, 2_000);
    const after = await db.select({ id: expenseRecords.id }).from(expenseRecords).where(eq(expenseRecords.academyId, f.academyId));
    expect(after).toHaveLength(before.length);
  });

  it("a member limited to other branches can't order for this branch's student or for this branch, nor see or pay its orders", async () => {
    const userId = await createUser();
    await db.insert(academyMemberships).values({ userId, academyId: f.academyId, role: "manager", status: "active", academyWide: false });
    const limited: AuthContext = { userId, branchIds: [], academyWide: false };
    const forStudent = await createBookOrder(limited, { buyerType: "student", studentId: await newStudent(f), orderDate: TODAY, items: [{ bookId: f.bookA, quantity: 1 }], idempotencyKey: randomUUID() });
    expect(forStudent.ok).toBe(false);
    if (!forStudent.ok) expect(forStudent.error.code).toBe("not_found");
    const forBranch = await createBookOrder(limited, { buyerType: "other_person", buyerName: "Y", branchId: f.branchId, orderDate: TODAY, items: [{ bookId: f.bookA, quantity: 1 }], idempotencyKey: randomUUID() });
    expect(forBranch.ok).toBe(false);
    const ours = await order(f);
    if (!ours.ok) throw new Error(ours.error.message);
    const seen = await getBookOrdersOverview(limited);
    if (!seen.ok) throw new Error(seen.error.message);
    expect(seen.overview.orders.some((o) => o.id === ours.orderId)).toBe(false);
    expect((await recordBookOrderPayment(limited, { orderId: ours.orderId, amountCents: 100, method: "cash", paidOn: TODAY, idempotencyKey: randomUUID() })).ok).toBe(false);
  });
});

describe("old supplier order rows (before 0052) stay as history only", () => {
  it("are kept in the database but never listed, paid, given, discounted or cancelled", async () => {
    const [{ n }] = await db
      .select({ n: sql<number>`coalesce(max(${bookOrders.orderNumber}), 0)::int + 1` })
      .from(bookOrders)
      .where(eq(bookOrders.academyId, f.academyId));
    const [legacy] = await db
      .insert(bookOrders)
      .values({ academyId: f.academyId, orderNumber: n, supplierName: "Old Supplier Ltd", orderDate: TODAY, currency: "USD", totalCents: 5_000, idempotencyKey: randomUUID(), createdBy: f.owner.userId })
      .returning({ id: bookOrders.id });
    await db.insert(bookOrderItems).values({ academyId: f.academyId, orderId: legacy.id, bookId: f.bookA, quantity: 5, unitCostCents: 1_000, lineTotalCents: 5_000 });

    const overview = await getBookOrdersOverview(f.owner);
    if (!overview.ok) throw new Error(overview.error.message);
    expect(overview.overview.orders.some((o) => o.id === legacy.id)).toBe(false);
    expect(overview.overview.orders.every((o) => o.buyerType !== null)).toBe(true);
    const results = [
      await pay(f, legacy.id, 100),
      await issueBooksToStudent(f.owner, { orderId: legacy.id, bookId: f.bookA, quantity: 1, issuedOn: TODAY, idempotencyKey: randomUUID() }),
      await cancelBookOrder(f.owner, legacy.id),
      await updateBookOrderDiscount(f.owner, { orderId: legacy.id, discountType: "fixed", discountValue: 100 }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("not_found");
    }
    const [kept] = await db.select().from(bookOrders).where(eq(bookOrders.id, legacy.id));
    expect(kept).toMatchObject({ supplierName: "Old Supplier Ltd", status: "ordered", totalCents: 5_000 });
  });
});
