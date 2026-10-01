import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { getBookCoverKey } from "@/lib/storage/keys";
import type { AcademyRole } from "@/lib/auth/roles";
import type { AuthContext } from "@/lib/auth/auth-context";
import { createBook } from "./books";
import { addBookSalePayment, createBookSale } from "./book-sales";
import { getBookSaleReceiptPrintData } from "./book-sale-receipt-print";

// `createBook` requires a verified cover — same mock pattern as
// books.test.ts/book-sales.test.ts.
vi.mock("@/lib/storage/client", () => ({
  getUploadUrl: vi.fn(),
  deleteObject: vi.fn(),
  getDownloadUrl: vi.fn(),
  headObject: vi.fn(),
}));
import { headObject } from "@/lib/storage/client";
const headObjectMock = vi.mocked(headObject);

beforeEach(() => {
  headObjectMock.mockReset();
  headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });
});

const createdUserIds: string[] = [];
const createdAcademyIds: string[] = [];
const createdPlanIds: string[] = [];

async function createUser(): Promise<string> {
  const [user] = await db.insert(users).values({ email: `receipt-test-${randomUUID()}@example.com`, passwordHash: "not-a-real-hash" }).returning({ id: users.id });
  createdUserIds.push(user.id);
  return user.id;
}

async function createPlan(): Promise<string> {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      name: `Receipt Test Plan ${randomUUID()}`,
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
    .values({ name: `Receipt Test Academy ${randomUUID()}`, slug: `receipt-test-${randomUUID()}`, defaultCurrency: "USD", createdBy: creatorUserId })
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

async function insertStudentDirect(academyId: string, branchId: string, creatorUserId: string, phone: string | null = null) {
  const [row] = await db
    .insert(students)
    .values({ academyId, branchId, studentNumber: `STD-${randomUUID().slice(0, 8)}`, fullName: "Receipt Test Student", phone, createdBy: creatorUserId })
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
  const studentId = await insertStudentDirect(academyId, branchId, creatorUserId, "+1-555-0100");
  const managerUserId = await createUser();
  await addMembership(managerUserId, academyId, "manager");
  return { academyId, branchId, studentId, creatorUserId, managerContext: { userId: managerUserId, branchIds: [], academyWide: false } };
}

async function insertBookDirect(academyId: string, context: AuthContext, priceCents = 1000, stockQuantity = 20, isbn?: string) {
  const result = await createBook(context, {
    name: `Receipt Test Book ${randomUUID()}`,
    priceCents,
    stockQuantity,
    isbn,
    coverRef: getBookCoverKey({ academyId, extension: "png" }),
  });
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

describe("getBookSaleReceiptPrintData", () => {
  it("never shows the full sale amount as paid for a partially-paid sale, and running totals match the spec's $100/$40/$30 example", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 10000, 20); // $100 final (qty 1, no discount)
    const sale = await createBookSale(fixture.managerContext, {
      bookId: book.id,
      buyerType: "student",
      studentId: fixture.studentId,
      quantity: 1,
      amountPaidCents: 4000, // $40
      method: "cash",
    });
    if (!sale.ok) throw new Error("expected ok");

    const afterFirst = await getBookSaleReceiptPrintData(fixture.managerContext, sale.sale.id);
    expect(afterFirst.ok).toBe(true);
    if (afterFirst.ok) {
      expect(afterFirst.data.sale.finalAmountCents).toBe(10000);
      expect(afterFirst.data.sale.totalPaidCents).toBe(4000);
      expect(afterFirst.data.sale.remainingCents).toBe(6000);
      expect(afterFirst.data.payments.length).toBe(1);
      expect(afterFirst.data.payments[0].amountCents).toBe(4000);
      expect(afterFirst.data.payments[0].runningTotalPaidCents).toBe(4000);
      expect(afterFirst.data.payments[0].remainingAfterCents).toBe(6000);
    }

    const additional = await addBookSalePayment(fixture.managerContext, { bookSaleId: sale.sale.id, amountCents: 3000, method: "cash" }); // $30
    expect(additional.ok).toBe(true);

    const afterSecond = await getBookSaleReceiptPrintData(fixture.managerContext, sale.sale.id);
    expect(afterSecond.ok).toBe(true);
    if (afterSecond.ok) {
      expect(afterSecond.data.sale.totalPaidCents).toBe(7000); // $70 total — never $100
      expect(afterSecond.data.sale.remainingCents).toBe(3000); // $30 remaining
      expect(afterSecond.data.payments.length).toBe(2);
      const secondPayment = afterSecond.data.payments.find((p) => p.amountCents === 3000);
      expect(secondPayment).toBeDefined();
      // "Payment received now" for the 2nd payment is $30, never $70 or $100.
      expect(secondPayment?.amountCents).toBe(3000);
      // "Total paid" as of the 2nd payment is $70, matching the spec's example exactly.
      expect(secondPayment?.runningTotalPaidCents).toBe(7000);
      expect(secondPayment?.remainingAfterCents).toBe(3000);
      expect(secondPayment?.ordinal).toBe(2);

      const firstPayment = afterSecond.data.payments.find((p) => p.amountCents === 4000);
      // The FIRST payment's own running total must still read $40/$60 even
      // after a second payment exists — it reflects the state as of THAT
      // payment, not the sale's current totals.
      expect(firstPayment?.runningTotalPaidCents).toBe(4000);
      expect(firstPayment?.remainingAfterCents).toBe(6000);
      expect(firstPayment?.ordinal).toBe(1);
    }
  });

  it("shows Paid = $0 and an empty payments list for a fully unpaid sale, never a fabricated receipt", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 5000, 20);
    const sale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 0 });
    if (!sale.ok) throw new Error("expected ok");

    const result = await getBookSaleReceiptPrintData(fixture.managerContext, sale.sale.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.sale.totalPaidCents).toBe(0);
      expect(result.data.sale.remainingCents).toBe(5000);
      expect(result.data.sale.paymentStatus).toBe("unpaid");
      expect(result.data.payments).toEqual([]);
    }
  });

  it("includes buyer student name/number/phone for a student sale, and name/phone for an other_person sale", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);

    const studentSale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "student", studentId: fixture.studentId, quantity: 1, amountPaidCents: 0 });
    if (!studentSale.ok) throw new Error("expected ok");
    const studentResult = await getBookSaleReceiptPrintData(fixture.managerContext, studentSale.sale.id);
    expect(studentResult.ok).toBe(true);
    if (studentResult.ok && studentResult.data.buyer.type === "student") {
      expect(studentResult.data.buyer.studentName).toBe("Receipt Test Student");
      expect(studentResult.data.buyer.studentNumber).toBeTruthy();
      expect(studentResult.data.buyer.phone).toBe("+1-555-0100");
    } else {
      throw new Error("expected student buyer");
    }

    const otherSale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Jane Walk-in", otherBuyerPhone: "+1-555-0200", quantity: 1, amountPaidCents: 0 });
    if (!otherSale.ok) throw new Error("expected ok");
    const otherResult = await getBookSaleReceiptPrintData(fixture.managerContext, otherSale.sale.id);
    expect(otherResult.ok).toBe(true);
    if (otherResult.ok && otherResult.data.buyer.type === "other_person") {
      expect(otherResult.data.buyer.name).toBe("Jane Walk-in");
      expect(otherResult.data.buyer.phone).toBe("+1-555-0200");
    } else {
      throw new Error("expected other_person buyer");
    }
  });

  it("includes the book's ISBN when set", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20, "ISBN-999-888");
    const sale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 0 });
    if (!sale.ok) throw new Error("expected ok");

    const result = await getBookSaleReceiptPrintData(fixture.managerContext, sale.sale.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.book.isbn).toBe("ISBN-999-888");
  });

  it("produces a stable, deterministic receipt number for the same sale across repeated calls", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);
    const sale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 0 });
    if (!sale.ok) throw new Error("expected ok");

    const first = await getBookSaleReceiptPrintData(fixture.managerContext, sale.sale.id);
    const second = await getBookSaleReceiptPrintData(fixture.managerContext, sale.sale.id);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.data.sale.receiptNumber).toBe(second.data.sale.receiptNumber);
      expect(first.data.sale.receiptNumber).toMatch(/^BS-[0-9A-F]{8}$/);
    }
  });

  it("rejects a sale id belonging to a different academy with the same not_found error as a nonexistent id (tenant isolation)", async () => {
    const fixture = await setupFixture();
    const other = await setupFixture();
    const book = await insertBookDirect(other.academyId, other.managerContext, 1000, 20);
    const sale = await createBookSale(other.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 0 });
    if (!sale.ok) throw new Error("expected ok");

    const result = await getBookSaleReceiptPrintData(fixture.managerContext, sale.sale.id);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected not ok");
    expect(result.error.code).toBe("not_found");

    const nonexistent = await getBookSaleReceiptPrintData(fixture.managerContext, randomUUID());
    expect(nonexistent.ok).toBe(false);
    if (nonexistent.ok) throw new Error("expected not ok");
    expect(nonexistent.error.code).toBe(result.error.code);
  });

  it("forbids a role with no books access from viewing the receipt", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);
    const sale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 0 });
    if (!sale.ok) throw new Error("expected ok");

    const outsiderUserId = await createUser();
    // No academy membership at all for this user — resolveAccess's
    // checkAcademyAccessForContext should refuse before any permission row
    // is even consulted.
    const result = await getBookSaleReceiptPrintData({ userId: outsiderUserId, branchIds: [], academyWide: false }, sale.sale.id);
    expect(result.ok).toBe(false);
  });

  it("resolves recordedByLabel per payment, not just at the sale level", async () => {
    const fixture = await setupFixture();
    const book = await insertBookDirect(fixture.academyId, fixture.managerContext, 1000, 20);
    const sale = await createBookSale(fixture.managerContext, { bookId: book.id, buyerType: "other_person", otherBuyerName: "Walk-in", quantity: 1, amountPaidCents: 500, method: "cash" });
    if (!sale.ok) throw new Error("expected ok");

    const result = await getBookSaleReceiptPrintData(fixture.managerContext, sale.sale.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.recordedByLabel).toBe("Manager");
      expect(result.data.payments[0].recordedByLabel).toBe("Manager");
    }
  });
});
