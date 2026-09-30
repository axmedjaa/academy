import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { books, bookSalePayments, bookSaleRefunds, bookSales, branches, incomeRecords, students } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_BOOKS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * Book Sales (§41-63). No approval workflow (matches income_records' own
 * "posts directly" design — see ACADEMY_BOOKS_ACTION's comment).
 *
 * ---------------------------------------------------------------------
 * Income integration — one income_records row PER PAYMENT EVENT, not one
 * per sale for the full final amount
 * ---------------------------------------------------------------------
 * §3/§0 are explicit that this system only ever records money the academy
 * has ALREADY RECEIVED. A partially-paid sale (final $18, paid $10) has
 * only actually received $10 — booking $18 as income at sale-creation time
 * would count the unpaid $8 as revenue before it exists, which §80's own
 * closing sentence explicitly warns against ("Do not incorrectly treat the
 * unpaid $8 as received income"). So: `createBookSale`'s initial payment
 * (if any) and every later `addBookSalePayment` each post their own
 * income_records row (category "book_sale") for exactly the amount
 * actually paid at that moment — never the sale's full final amount.
 *
 * ---------------------------------------------------------------------
 * Refunds do not touch income_records
 * ---------------------------------------------------------------------
 * income_records' existing reversal mechanism (lib/academies/
 * finance-reversals.ts) is built for "this whole record was wrong, fully
 * retire it" — it doesn't fit "give back part of the money from one of
 * several payment events against a sale." Rather than force that
 * abstraction, refunds are tracked in their own `book_sale_refunds` table
 * (full history, never destroying the original payment records — §53/§57),
 * and reporting nets book-sale income against total refunds explicitly
 * (see `listBookSales`'s `netPaidCents`) — auditable and correct without
 * misusing a mechanism designed for a different shape.
 *
 * ---------------------------------------------------------------------
 * Concurrency (§49)
 * ---------------------------------------------------------------------
 * `createBookSale` and refunds that restore stock both lock the `books` row
 * with `SELECT ... FOR UPDATE` before checking/mutating stock, inside one
 * transaction — a second concurrent sale of the same book blocks until the
 * first commits (or rolls back), then sees the updated stock and correctly
 * refuses if it's no longer sufficient. Same pattern as
 * student-payments.ts's `issueReceipt` row-locking a payment before
 * generating a receipt number.
 */
function canManage(level: AcademyPermissionLevel): boolean {
  return level === "manage";
}

export interface BookSaleActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict";
  message: string;
}

const FORBIDDEN: BookSaleActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's book sales.",
};
const BOOK_NOT_FOUND: BookSaleActionError = { code: "not_found", message: "Book not found." };
const SALE_NOT_FOUND: BookSaleActionError = { code: "not_found", message: "Book sale not found." };
const STUDENT_NOT_FOUND: BookSaleActionError = { code: "not_found", message: "Student not found." };
const BRANCH_NOT_FOUND: BookSaleActionError = { code: "not_found", message: "Branch not found." };

interface ResolvedAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveAccessResult = { ok: true; access: ResolvedAccess } | { ok: false; error: BookSaleActionError };

async function resolveAccess(actorContext: AuthContext): Promise<ResolveAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  const permissionLevel = getAcademyPermissionLevel(access.membershipRole, ACADEMY_BOOKS_ACTION);
  if (permissionLevel === "none") return { ok: false, error: FORBIDDEN };
  return { ok: true, access: { academyId: access.academyId, membershipRole: access.membershipRole, permissionLevel } };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505";
}

// ===========================================================================
// Pricing math (§44-45) — always server-side, never trusts a client total.
// ===========================================================================

export function computeBookSalePricing(
  unitPriceCents: number,
  quantity: number,
  discountType: "none" | "fixed" | "percentage",
  discountValue: number,
): { subtotalCents: number; discountAmountCents: number; finalAmountCents: number } {
  const subtotalCents = unitPriceCents * quantity;
  let discountAmountCents = 0;
  if (discountType === "fixed") {
    discountAmountCents = Math.min(discountValue, subtotalCents);
  } else if (discountType === "percentage") {
    discountAmountCents = Math.round((subtotalCents * discountValue) / 100);
  }
  const finalAmountCents = Math.max(0, subtotalCents - discountAmountCents);
  return { subtotalCents, discountAmountCents, finalAmountCents };
}

function derivePaymentStatus(finalAmountCents: number, paidCents: number): "unpaid" | "partially_paid" | "paid" {
  if (paidCents <= 0) return "unpaid";
  if (paidCents >= finalAmountCents) return "paid";
  return "partially_paid";
}

// ===========================================================================
// Create sale (§41-48)
// ===========================================================================

export const createBookSaleSchema = z
  .object({
    bookId: z.string().uuid("Invalid book id"),
    buyerType: z.enum(["student", "other_person"]),
    studentId: z.string().uuid("Invalid student id").optional(),
    otherBuyerName: z.string().trim().max(200).optional(),
    otherBuyerPhone: z.string().trim().max(50).optional(),
    branchId: z.string().uuid("Invalid branch id").optional(),
    quantity: z.number().int("Quantity must be a whole number").positive("Quantity must be at least 1"),
    discountType: z.enum(["none", "fixed", "percentage"]).default("none"),
    discountValue: z.number().int("Discount must be a whole number").nonnegative("Discount cannot be negative").default(0),
    amountPaidCents: z.number().int("Amount must be a whole number of cents").nonnegative("Amount cannot be negative").default(0),
    method: z.enum(["cash", "mobile_money"]).optional(),
    reference: z
      .string()
      .trim()
      .max(200)
      .optional()
      .or(z.literal(""))
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    paidAt: z.coerce.date().optional(),
  })
  .refine((data) => data.buyerType !== "student" || !!data.studentId, {
    message: "Select a student.",
    path: ["studentId"],
  })
  .refine((data) => data.buyerType !== "other_person" || (!!data.otherBuyerName && data.otherBuyerName.length > 0), {
    message: "Buyer name is required.",
    path: ["otherBuyerName"],
  })
  .refine((data) => data.discountType !== "percentage" || data.discountValue <= 100, {
    message: "Percentage discount cannot exceed 100.",
    path: ["discountValue"],
  })
  .refine((data) => data.amountPaidCents <= 0 || !!data.method, {
    message: "Select a payment method.",
    path: ["method"],
  });

export type CreateBookSaleInput = z.input<typeof createBookSaleSchema>;

export interface BookSaleRecord {
  id: string;
  academyId: string;
  bookId: string;
  branchId: string | null;
  buyerType: "student" | "other_person";
  studentId: string | null;
  otherBuyerName: string | null;
  otherBuyerPhone: string | null;
  quantity: number;
  unitPriceCents: number;
  currency: string;
  subtotalCents: number;
  discountType: "none" | "fixed" | "percentage";
  discountValue: number;
  discountAmountCents: number;
  finalAmountCents: number;
  paymentStatus: "unpaid" | "partially_paid" | "paid";
  recordedBy: string;
  createdAt: Date;
}

function toSaleRecord(row: typeof bookSales.$inferSelect): BookSaleRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    bookId: row.bookId,
    branchId: row.branchId,
    buyerType: row.buyerType,
    studentId: row.studentId,
    otherBuyerName: row.otherBuyerName,
    otherBuyerPhone: row.otherBuyerPhone,
    quantity: row.quantity,
    unitPriceCents: row.unitPriceCents,
    currency: row.currency,
    subtotalCents: row.subtotalCents,
    discountType: row.discountType,
    discountValue: row.discountValue,
    discountAmountCents: row.discountAmountCents,
    finalAmountCents: row.finalAmountCents,
    paymentStatus: row.paymentStatus,
    recordedBy: row.recordedBy,
    createdAt: row.createdAt,
  };
}

export type CreateBookSaleResult = { ok: true; sale: BookSaleRecord } | { ok: false; error: BookSaleActionError };

export async function createBookSale(actorContext: AuthContext, input: CreateBookSaleInput): Promise<CreateBookSaleResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;
  if (!canManage(permissionLevel)) return { ok: false, error: FORBIDDEN };

  const parsed = createBookSaleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [book] = await tx.select().from(books).where(eq(books.id, data.bookId)).for("update");
    if (!book || book.academyId !== academyId) return { kind: "book_not_found" as const };
    if (book.status !== "active") return { kind: "inactive" as const };
    if (book.stockQuantity < data.quantity) return { kind: "insufficient_stock" as const, available: book.stockQuantity };

    if (data.buyerType === "student") {
      const [student] = await tx
        .select({ id: students.id, academyId: students.academyId })
        .from(students)
        .where(eq(students.id, data.studentId!))
        .limit(1);
      if (!student || student.academyId !== academyId) return { kind: "student_not_found" as const };
    }

    if (data.branchId) {
      const [branch] = await tx
        .select({ id: branches.id, academyId: branches.academyId })
        .from(branches)
        .where(eq(branches.id, data.branchId))
        .limit(1);
      if (!branch || branch.academyId !== academyId) return { kind: "branch_not_found" as const };
    }

    const { subtotalCents, discountAmountCents, finalAmountCents } = computeBookSalePricing(
      book.priceCents,
      data.quantity,
      data.discountType,
      data.discountValue,
    );

    if (data.amountPaidCents > finalAmountCents) {
      return { kind: "overpaid" as const, finalAmountCents };
    }

    const [sale] = await tx
      .insert(bookSales)
      .values({
        academyId,
        branchId: data.branchId,
        bookId: data.bookId,
        buyerType: data.buyerType,
        studentId: data.buyerType === "student" ? data.studentId : null,
        otherBuyerName: data.buyerType === "other_person" ? data.otherBuyerName : null,
        otherBuyerPhone: data.buyerType === "other_person" ? data.otherBuyerPhone : null,
        quantity: data.quantity,
        unitPriceCents: book.priceCents,
        currency: book.currency,
        subtotalCents,
        discountType: data.discountType,
        discountValue: data.discountType === "none" ? 0 : data.discountValue,
        discountAmountCents,
        finalAmountCents,
        paymentStatus: derivePaymentStatus(finalAmountCents, data.amountPaidCents),
        recordedBy: actorContext.userId,
      })
      .returning();

    await tx.update(books).set({ stockQuantity: book.stockQuantity - data.quantity }).where(eq(books.id, book.id));

    if (data.amountPaidCents > 0) {
      const [income] = await tx
        .insert(incomeRecords)
        .values({
          academyId,
          branchId: data.branchId,
          category: "book_sale",
          description: `Book sale: ${book.name} x${data.quantity}`,
          amountCents: data.amountPaidCents,
          currency: book.currency,
          recordedBy: actorContext.userId,
        })
        .returning();

      await tx.insert(bookSalePayments).values({
        academyId,
        bookSaleId: sale.id,
        amountCents: data.amountPaidCents,
        method: data.method!,
        reference: data.reference,
        paidAt: data.paidAt ?? new Date(),
        recordedBy: actorContext.userId,
        incomeRecordId: income.id,
      });
    }

    await recordAudit(
      { actorUserId: actorContext.userId, actorRole: membershipRole, academyId, action: "createBookSale", entityType: "book_sale", entityId: sale.id, after: toSaleRecord(sale) },
      tx,
    );

    return { kind: "ok" as const, sale };
  });

  if (result.kind === "book_not_found") return { ok: false, error: BOOK_NOT_FOUND };
  if (result.kind === "inactive") return { ok: false, error: { code: "validation", message: "This book is inactive and cannot be sold." } };
  if (result.kind === "insufficient_stock") {
    return { ok: false, error: { code: "conflict", message: `Only ${result.available} in stock.` } };
  }
  if (result.kind === "student_not_found") return { ok: false, error: STUDENT_NOT_FOUND };
  if (result.kind === "branch_not_found") return { ok: false, error: BRANCH_NOT_FOUND };
  if (result.kind === "overpaid") {
    return { ok: false, error: { code: "conflict", message: `Amount paid cannot exceed the final amount (${result.finalAmountCents} cents).` } };
  }
  return { ok: true, sale: toSaleRecord(result.sale) };
}

// ===========================================================================
// Additional payment (§51-52)
// ===========================================================================

export const addBookSalePaymentSchema = z.object({
  bookSaleId: z.string().uuid("Invalid book sale id"),
  amountCents: z.number().int("Amount must be a whole number of cents").positive("Amount must be greater than zero"),
  method: z.enum(["cash", "mobile_money"]),
  reference: z
    .string()
    .trim()
    .max(200)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  paidAt: z.coerce.date().optional(),
});

export type AddBookSalePaymentInput = z.input<typeof addBookSalePaymentSchema>;

export type AddBookSalePaymentResult = { ok: true; sale: BookSaleRecord } | { ok: false; error: BookSaleActionError };

export async function addBookSalePayment(actorContext: AuthContext, input: AddBookSalePaymentInput): Promise<AddBookSalePaymentResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;
  if (!canManage(permissionLevel)) return { ok: false, error: FORBIDDEN };

  const parsed = addBookSalePaymentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [sale] = await tx.select().from(bookSales).where(eq(bookSales.id, data.bookSaleId)).for("update");
    if (!sale || sale.academyId !== academyId) return { kind: "not_found" as const };

    const [paidRow] = await tx
      .select({ total: sql<string>`coalesce(sum(${bookSalePayments.amountCents}), 0)` })
      .from(bookSalePayments)
      .where(eq(bookSalePayments.bookSaleId, sale.id));
    const totalPaid = Number(paidRow?.total ?? 0);
    const remaining = sale.finalAmountCents - totalPaid;
    if (data.amountCents > remaining) {
      return { kind: "exceeds_balance" as const, remainingCents: Math.max(0, remaining) };
    }

    const [book] = await tx.select({ name: books.name }).from(books).where(eq(books.id, sale.bookId)).limit(1);

    const [income] = await tx
      .insert(incomeRecords)
      .values({
        academyId,
        branchId: sale.branchId,
        category: "book_sale",
        description: `Book sale payment: ${book?.name ?? "book"}`,
        amountCents: data.amountCents,
        currency: sale.currency,
        recordedBy: actorContext.userId,
      })
      .returning();

    await tx.insert(bookSalePayments).values({
      academyId,
      bookSaleId: sale.id,
      amountCents: data.amountCents,
      method: data.method,
      reference: data.reference,
      paidAt: data.paidAt ?? new Date(),
      recordedBy: actorContext.userId,
      incomeRecordId: income.id,
    });

    const newTotalPaid = totalPaid + data.amountCents;
    const [updated] = await tx
      .update(bookSales)
      .set({ paymentStatus: derivePaymentStatus(sale.finalAmountCents, newTotalPaid) })
      .where(eq(bookSales.id, sale.id))
      .returning();

    await recordAudit(
      { actorUserId: actorContext.userId, actorRole: membershipRole, academyId, action: "addBookSalePayment", entityType: "book_sale", entityId: sale.id, before: { paymentStatus: sale.paymentStatus }, after: { paymentStatus: updated.paymentStatus, amountCents: data.amountCents } },
      tx,
    );

    return { kind: "ok" as const, sale: updated };
  });

  if (result.kind === "not_found") return { ok: false, error: SALE_NOT_FOUND };
  if (result.kind === "exceeds_balance") {
    return { ok: false, error: { code: "conflict", message: `Amount exceeds the outstanding balance (remaining: ${result.remainingCents} cents).` } };
  }
  return { ok: true, sale: toSaleRecord(result.sale) };
}

// ===========================================================================
// Refunds (§53-57)
// ===========================================================================

export const refundBookSaleSchema = z.object({
  bookSaleId: z.string().uuid("Invalid book sale id"),
  amountCents: z.number().int("Amount must be a whole number of cents").positive("Amount must be greater than zero"),
  reason: z.string().trim().min(1, "A refund reason is required.").max(2000),
  returnedQuantity: z.number().int("Returned quantity must be a whole number").nonnegative("Returned quantity cannot be negative").default(0),
});

export type RefundBookSaleInput = z.input<typeof refundBookSaleSchema>;

export interface BookSaleRefundRecord {
  id: string;
  bookSaleId: string;
  amountCents: number;
  reason: string;
  returnedQuantity: number;
  createdAt: Date;
}

export type RefundBookSaleResult = { ok: true; refund: BookSaleRefundRecord } | { ok: false; error: BookSaleActionError };

export async function refundBookSale(actorContext: AuthContext, input: RefundBookSaleInput): Promise<RefundBookSaleResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;
  if (!canManage(permissionLevel)) return { ok: false, error: FORBIDDEN };

  const parsed = refundBookSaleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [sale] = await tx.select().from(bookSales).where(eq(bookSales.id, data.bookSaleId)).for("update");
    if (!sale || sale.academyId !== academyId) return { kind: "not_found" as const };

    const [paidRow] = await tx
      .select({ total: sql<string>`coalesce(sum(${bookSalePayments.amountCents}), 0)` })
      .from(bookSalePayments)
      .where(eq(bookSalePayments.bookSaleId, sale.id));
    const totalPaid = Number(paidRow?.total ?? 0);

    const [refundedRow] = await tx
      .select({
        totalAmount: sql<string>`coalesce(sum(${bookSaleRefunds.amountCents}), 0)`,
        totalQuantity: sql<string>`coalesce(sum(${bookSaleRefunds.returnedQuantity}), 0)`,
      })
      .from(bookSaleRefunds)
      .where(eq(bookSaleRefunds.bookSaleId, sale.id));
    const totalRefunded = Number(refundedRow?.totalAmount ?? 0);
    const totalReturnedQuantity = Number(refundedRow?.totalQuantity ?? 0);

    const refundableAmount = totalPaid - totalRefunded;
    if (data.amountCents > refundableAmount) {
      return { kind: "exceeds_refundable" as const, refundableCents: Math.max(0, refundableAmount) };
    }

    const refundableQuantity = sale.quantity - totalReturnedQuantity;
    if (data.returnedQuantity > refundableQuantity) {
      return { kind: "exceeds_quantity" as const, refundableQuantity: Math.max(0, refundableQuantity) };
    }

    const [refund] = await tx
      .insert(bookSaleRefunds)
      .values({
        academyId,
        bookSaleId: sale.id,
        amountCents: data.amountCents,
        reason: data.reason,
        returnedQuantity: data.returnedQuantity,
        recordedBy: actorContext.userId,
      })
      .returning();

    if (data.returnedQuantity > 0) {
      const [book] = await tx.select().from(books).where(eq(books.id, sale.bookId)).for("update");
      if (book) {
        await tx.update(books).set({ stockQuantity: book.stockQuantity + data.returnedQuantity, updatedAt: new Date() }).where(eq(books.id, book.id));
      }
    }

    const isFullRefund = data.amountCents === refundableAmount && data.returnedQuantity === refundableQuantity;
    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: isFullRefund ? "createBookSaleRefund" : "createBookSalePartialRefund",
        entityType: "book_sale",
        entityId: sale.id,
        after: { refundId: refund.id, amountCents: refund.amountCents, returnedQuantity: refund.returnedQuantity, reason: refund.reason },
      },
      tx,
    );

    return { kind: "ok" as const, refund };
  });

  if (result.kind === "not_found") return { ok: false, error: SALE_NOT_FOUND };
  if (result.kind === "exceeds_refundable") {
    return { ok: false, error: { code: "conflict", message: `Refund amount exceeds the refundable amount (${result.refundableCents} cents).` } };
  }
  if (result.kind === "exceeds_quantity") {
    return { ok: false, error: { code: "conflict", message: `Returned quantity exceeds what can still be returned (${result.refundableQuantity}).` } };
  }
  return {
    ok: true,
    refund: {
      id: result.refund.id,
      bookSaleId: result.refund.bookSaleId,
      amountCents: result.refund.amountCents,
      reason: result.refund.reason,
      returnedQuantity: result.refund.returnedQuantity,
      createdAt: result.refund.createdAt,
    },
  };
}

// ===========================================================================
// Reading (§50-52)
// ===========================================================================

export interface BookSaleListRow extends BookSaleRecord {
  bookName: string;
  studentName: string | null;
  totalPaidCents: number;
  totalRefundedCents: number;
  netPaidCents: number;
  remainingCents: number;
}

export type ListBookSalesResult = { ok: true; sales: BookSaleListRow[]; canManage: boolean } | { ok: false; error: BookSaleActionError };

export async function listBookSales(
  actorContext: AuthContext,
  filters: { bookId?: string; studentId?: string; paymentStatus?: "unpaid" | "partially_paid" | "paid" } = {},
): Promise<ListBookSalesResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, permissionLevel } = resolved.access;

  const conditions = [eq(bookSales.academyId, academyId)];
  if (filters.bookId) conditions.push(eq(bookSales.bookId, filters.bookId));
  if (filters.studentId) conditions.push(eq(bookSales.studentId, filters.studentId));
  if (filters.paymentStatus) conditions.push(eq(bookSales.paymentStatus, filters.paymentStatus));

  const saleRows = await db
    .select({ sale: bookSales, bookName: books.name, studentName: students.fullName })
    .from(bookSales)
    .innerJoin(books, eq(bookSales.bookId, books.id))
    .leftJoin(students, eq(bookSales.studentId, students.id))
    .where(and(...conditions));

  const saleIds = saleRows.map((row) => row.sale.id);
  const paidTotals = saleIds.length
    ? await db
        .select({ bookSaleId: bookSalePayments.bookSaleId, total: sql<string>`coalesce(sum(${bookSalePayments.amountCents}), 0)` })
        .from(bookSalePayments)
        .where(sql`${bookSalePayments.bookSaleId} = ANY(${saleIds})`)
        .groupBy(bookSalePayments.bookSaleId)
    : [];
  const refundTotals = saleIds.length
    ? await db
        .select({ bookSaleId: bookSaleRefunds.bookSaleId, total: sql<string>`coalesce(sum(${bookSaleRefunds.amountCents}), 0)` })
        .from(bookSaleRefunds)
        .where(sql`${bookSaleRefunds.bookSaleId} = ANY(${saleIds})`)
        .groupBy(bookSaleRefunds.bookSaleId)
    : [];
  const paidById = new Map(paidTotals.map((row) => [row.bookSaleId, Number(row.total)]));
  const refundedById = new Map(refundTotals.map((row) => [row.bookSaleId, Number(row.total)]));

  const sales = saleRows.map(({ sale, bookName, studentName }) => {
    const totalPaidCents = paidById.get(sale.id) ?? 0;
    const totalRefundedCents = refundedById.get(sale.id) ?? 0;
    return {
      ...toSaleRecord(sale),
      bookName,
      studentName,
      totalPaidCents,
      totalRefundedCents,
      netPaidCents: totalPaidCents - totalRefundedCents,
      remainingCents: Math.max(0, sale.finalAmountCents - totalPaidCents),
    };
  });

  return { ok: true, sales, canManage: canManage(permissionLevel) };
}

export interface BookSaleDetail extends BookSaleListRow {
  payments: { id: string; amountCents: number; method: "cash" | "mobile_money"; reference: string | null; paidAt: Date }[];
  refunds: { id: string; amountCents: number; reason: string; returnedQuantity: number; createdAt: Date }[];
}

export type GetBookSaleResult = { ok: true; sale: BookSaleDetail } | { ok: false; error: BookSaleActionError };

export async function getBookSale(actorContext: AuthContext, bookSaleId: string): Promise<GetBookSaleResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId } = resolved.access;

  const parsedId = z.string().uuid().safeParse(bookSaleId);
  if (!parsedId.success) return { ok: false, error: SALE_NOT_FOUND };

  const [row] = await db
    .select({ sale: bookSales, bookName: books.name, studentName: students.fullName })
    .from(bookSales)
    .innerJoin(books, eq(bookSales.bookId, books.id))
    .leftJoin(students, eq(bookSales.studentId, students.id))
    .where(eq(bookSales.id, bookSaleId))
    .limit(1);
  if (!row || row.sale.academyId !== academyId) return { ok: false, error: SALE_NOT_FOUND };

  const payments = await db.select().from(bookSalePayments).where(eq(bookSalePayments.bookSaleId, bookSaleId));
  const refunds = await db.select().from(bookSaleRefunds).where(eq(bookSaleRefunds.bookSaleId, bookSaleId));

  const totalPaidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
  const totalRefundedCents = refunds.reduce((sum, r) => sum + r.amountCents, 0);

  return {
    ok: true,
    sale: {
      ...toSaleRecord(row.sale),
      bookName: row.bookName,
      studentName: row.studentName,
      totalPaidCents,
      totalRefundedCents,
      netPaidCents: totalPaidCents - totalRefundedCents,
      remainingCents: Math.max(0, row.sale.finalAmountCents - totalPaidCents),
      payments: payments.map((p) => ({ id: p.id, amountCents: p.amountCents, method: p.method, reference: p.reference, paidAt: p.paidAt })),
      refunds: refunds.map((r) => ({ id: r.id, amountCents: r.amountCents, reason: r.reason, returnedQuantity: r.returnedQuantity, createdAt: r.createdAt })),
    },
  };
}

export { isUniqueViolation as isBookSalesUniqueViolation };
export type { DbClient as BookSalesDbClient };
