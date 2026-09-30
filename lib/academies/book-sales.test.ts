import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  academies,
  academyMemberships,
  academySubscriptions,
  auditLogs,
  bookSalePayments,
  bookSaleRefunds,
  bookSales,
  books,
  branches,
  incomeRecords,
  students,
  subscriptionPlans,
  users,
} from "@/lib/db/schema";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { createBook } from "./books";
import { addBookSalePayment, computeBookSalePricing, createBookSale, refundBookSale } from "./book-sales";

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db.insert(users).values({ email: `book-sales-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" }).returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Book Sales Test Plan ${randomUUID()}`,
      priceAmountCents: 1000,
      currency: "USD",
      billingPeriod: "monthly",
      maxBranches: 10,
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

async function createAcademy(creatorUserId: string): Promise<string> {
  const [academy] = await db
    .insert(academies)
    .values({ name: `Book Sales Test Academy ${randomUUID()}`, slug: `book-sales-test-${randomUUID()}`, defaultCurrency: "USD", createdBy: creatorUserId })
    .returning({ id: academies.id });
  createdAcademyIds.push(academy.id);
  return academy.id;
}

async function addMembership(userId: string, academyId: string, role: AcademyRole): Promise<void> {
  await db.insert(academyMemberships).values({ userId, academyId, role, status: "active" });
}

async function insertBranchDirect(academyId: string): Promise<string> {
  const [row] = await db.insert(branches).values({ academyId, name: `Branch ${randomUUID()}`, code: `BR-${randomUUID().slice(0, 8)}` }).returning({ id: branches.id });
  return row.id;
}

async function insertStudentDirect(academyId: string, branchId: string, creatorUserId: string): Promise<string> {
  const [row] = await db
    .insert(students)
    .values({ academyId, branchId, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "Test Student", createdBy: creatorUserId })
    .returning({ id: students.id });
  return row.id;
}

interface Fixture {
  academyId: string;
  branchId: string;
  studentId: string;
  creatorUserId: string;
  managerContext: AuthContext;
}

async function setupFixture(): Promise<Fixture> {
  const creatorUserId = await createUser();
  const academyId = await createAcademy(creatorUserId);
  const planId = await createPlan();
  await db.insert(academySubscriptions).values({ academyId, planId, status: "active", endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), createdBy: creatorUserId });
  const branchId = await insertBranchDirect(academyId);
  const studentId = await insertStudentDirect(academyId, branchId, creatorUserId);
  const managerUserId = await createUser();
  await addMembership(managerUserId, academyId, "manager");
  return { academyId, branchId, studentId, creatorUserId, managerContext: { userId: managerUserId, branchIds: [], academyWide: false } };
}

async function insertBookDirect(academyId: string, context: AuthContext, priceCents = 1000, stockQuantity = 20) {
  const result = await createBook(context, { name: `Book ${randomUUID()}`, priceCents, stockQuantity });
  if (!result.ok) throw new Error("failed to create book");
  return result.book;
}

afterAll(async () => {
  await db.delete(auditLogs).where(or(...createdAcademyIds.map((id) => eq(auditLogs.academyId, id)), ...createdUserIds.map((id) => eq(auditLogs.actorUserId, id))));
  for (const academyId of createdAcademyIds) {
    await db.delete(bookSaleRefunds).where(eq(bookSaleRefunds.academyId, academyId));
    await db.delete(bookSalePayments).where(eq(bookSalePayments.academyId, academyId));
    await db.delete(bookSales).where(eq(bookSales.academyId, academyId));
    await db.delete(incomeRecords).where(eq(incomeRecords.academyId, academyId));
    await db.delete(books).where(eq(books.academyId, academyId));
    await db.delete(students).where(eq(students.academyId, academyId));
    await db.delete(branches).where(eq(branches.academyId, academyId));
    await db.delete(academySubscriptions).where(eq(academySubscriptions.academyId, academyId));
    await db.delete(academyMemberships).where(eq(academyMemberships.academyId, academyId));
  }
  for (const academyId of createdAcademyIds) {
    await db.delete(academies).where(eq(academies.id, academyId));
  }
  for (const planId of createdPlanIds) {
    await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  }
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("computeBookSalePricing", () => {
  it("computes a fixed discount", () => {
    const result = computeBookSalePricing(1000, 2, "fixed", 300);
    expect(result).toEqual({ subtotalCents: 2000, discountAmountCents: 300, finalAmountCents: 1700 });
  });
  it("computes a percentage discount", () => {
    const result = computeBookSalePricing(1000, 2, "percentage", 10);
    expect(result).toEqual({ subtotalCents: 2000, discountAmountCents: 200, finalAmountCents: 1800 });
  });
  it("clamps a fixed discount larger than the subtotal to the subtotal (never negative final)", () => {
    const result = computeBookSalePricing(1000, 1, "fixed", 5000);
    expect(result.finalAmountCents).toBe(0);
  });
  it("no discount leaves the subtotal unchanged", () => {
    const result = computeBookSalePricing(1000, 3, "none", 0);
    expect(result).toEqual({ subtotalCents: 3000, discountAmountCents: 0, finalAmountCents: 3000 });
  });
});

describe("createBookSale", () => {
  it("sells to a student, decrements stock, snapshots price, and books only the amount actually paid as income", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);

    const result = await createBookSale(fixture.managerContext, {
      bookId: book.id,
      buyerType: "student",
      studentId: fixture.studentId,
      quantity: 2,
      discountType: "percentage",
      discountValue: 10,
      amountPaidCents: 1000,
      method: "mobile_money",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sale.subtotalCents).toBe(2000);
    expect(result.sale.discountAmountCents).toBe(200);
    expect(result.sale.finalAmountCents).toBe(1800);
    expect(result.sale.paymentStatus).toBe("partially_paid");

    const [updatedBook] = await db.select().from(books).where(eq(books.id, book.id));
    expect(updatedBook.stockQuantity).toBe(18);

    const income = await db.select().from(incomeRecords).where(eq(incomeRecords.academyId, fixture.academyId));
    const totalIncome = income.reduce((sum, row) => sum + row.amountCents, 0);
    expect(totalIncome).toBe(1000); // only the $10 actually received, not the $18 final amount
  });

  it("rejects selling more than available stock", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 2);
    const result = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 5, amountPaidCents: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  it("rejects selling an inactive book", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);
    await db.update(books).set({ status: "inactive" }).where(eq(books.id, book.id));
    const result = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("rejects an amount paid greater than the final amount (no overpayment)", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);
    const result = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 5000, method: "cash" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  it("requires a student id when buyerType is student, and a name when other_person", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext);
    const result = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "student", quantity: 1, amountPaidCents: 0 });
    expect(result.ok).toBe(false);
  });

  it("rejects a book belonging to a different academy", async () => {
    const fixture = await setupFixture();
    const other = await setupFixture();
    const otherBook = await insertBookDirect(other.academyId, other.managerContext);
    const result = await createBookSale(fixture.managerContext, { bookId: otherBook.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("Owner/Admin (view-only) cannot sell a book", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext);
    const ownerUserId = await createUser();
    await addMembership(ownerUserId, fixture.academyId, "academy_owner");
    const result = await createBookSale({ userId: ownerUserId, branchIds: [], academyWide: false }, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("forbidden");
  });
});

describe("addBookSalePayment", () => {
  it("marks the sale paid once total payments reach the final amount, across separate events", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);
    const sale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 2, amountPaidCents: 1000, method: "cash" });
    if (!sale.ok) throw new Error("expected ok");
    expect(sale.sale.finalAmountCents).toBe(2000);

    const additional = await addBookSalePayment(fixture.managerContext, { bookSaleId: sale.sale.id, amountCents: 1000, method: "cash" });
    expect(additional.ok).toBe(true);
    if (additional.ok) expect(additional.sale.paymentStatus).toBe("paid");

    const payments = await db.select().from(bookSalePayments).where(eq(bookSalePayments.bookSaleId, sale.sale.id));
    expect(payments.length).toBe(2); // both payment events remain visible, never merged
  });

  it("rejects an additional payment that would exceed the remaining balance", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);
    const sale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 0 });
    if (!sale.ok) throw new Error("expected ok");
    const result = await addBookSalePayment(fixture.managerContext, { bookSaleId: sale.sale.id, amountCents: 5000, method: "cash" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });
});

describe("refundBookSale", () => {
  it("records a partial refund without altering the original sale, and restores stock only for returned quantity", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);
    const sale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 2, amountPaidCents: 2000, method: "cash" });
    if (!sale.ok) throw new Error("expected ok");

    const refund = await refundBookSale(fixture.managerContext, { bookSaleId: sale.sale.id, amountCents: 500, reason: "Damaged copy", returnedQuantity: 1 });
    expect(refund.ok).toBe(true);

    const [unchangedSale] = await db.select().from(bookSales).where(eq(bookSales.id, sale.sale.id));
    expect(unchangedSale.finalAmountCents).toBe(2000); // original sale record untouched
    expect(unchangedSale.paymentStatus).toBe("paid");

    const [updatedBook] = await db.select().from(books).where(eq(books.id, book.id));
    expect(updatedBook.stockQuantity).toBe(19); // started at 20, sold 2 (->18), 1 returned (->19)
  });

  it("does not restore stock when no physical copies are returned", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);
    const sale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 2, amountPaidCents: 2000, method: "cash" });
    if (!sale.ok) throw new Error("expected ok");
    await refundBookSale(fixture.managerContext, { bookSaleId: sale.sale.id, amountCents: 500, reason: "Goodwill credit, no return" });

    const [updatedBook] = await db.select().from(books).where(eq(books.id, book.id));
    expect(updatedBook.stockQuantity).toBe(18); // unchanged by the refund
  });

  it("rejects a refund amount exceeding what was actually paid", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);
    const sale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 1000, method: "cash" });
    if (!sale.ok) throw new Error("expected ok");
    const result = await refundBookSale(fixture.managerContext, { bookSaleId: sale.sale.id, amountCents: 5000, reason: "Too much" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  it("rejects returning more copies than were sold", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);
    const sale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 1000, method: "cash" });
    if (!sale.ok) throw new Error("expected ok");
    const result = await refundBookSale(fixture.managerContext, { bookSaleId: sale.sale.id, amountCents: 500, reason: "Return", returnedQuantity: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  it("prevents double-refunding the same money twice", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);
    const sale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 1000, method: "cash" });
    if (!sale.ok) throw new Error("expected ok");
    const first = await refundBookSale(fixture.managerContext, { bookSaleId: sale.sale.id, amountCents: 1000, reason: "Full refund" });
    expect(first.ok).toBe(true);
    const second = await refundBookSale(fixture.managerContext, { bookSaleId: sale.sale.id, amountCents: 1, reason: "Nothing left" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("conflict");
  });
});
