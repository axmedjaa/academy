import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { bookIssues, bookOrderItems, bookOrderPayments, bookOrderReceipts, bookOrders, books, branches, incomeRecords, students } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { branchScopeCondition, getBranchScope, inBranchScope, type BranchScope } from "@/lib/academies/branch-access";
import { resolveStaffLabels } from "@/lib/academies/staff-labels";
import { ACADEMY_BOOKS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { formatMoney } from "@/lib/ui/money";
import {
  BOOK_ORDER_PAYMENT_METHODS,
  bookOrderPaymentStatus,
  type BookOrderPaymentMethod,
  type BookOrderPaymentStatus,
  type BookOrderStatus,
} from "@/lib/academies/book-order-math";

/**
 * Book Management, simplified (migrations 0051 + 0052): three operations.
 *
 * 1. ORDERS — Create Order: books bought by a Student (registered in this
 *    academy) or an Other Buyer (name, optional phone and email). Each line
 *    is priced at the book's current price (snapshot), then an optional
 *    fixed or percentage discount: total = subtotal - discount, all computed
 *    here. Each order gets the academy's next order number (0056). An
 *    optional first payment is saved in the same transaction. Creating an
 *    order or taking a payment never changes stock. Status: ordered |
 *    cancelled. Rows without a buyer are old supplier orders (before 0052):
 *    kept in the database as history, never listed or acted on.
 * 2. PAYMENTS — money the buyer pays for an order. A payment always belongs
 *    to an existing, non-cancelled order; partial payments are allowed,
 *    overpaying is not. Each payment posts its own income_records row
 *    (category "book_order") for exactly the amount received — the same
 *    convention as book-sale payments. The payment status (unpaid /
 *    partially paid / fully paid) is derived, never stored.
 * 3. ISSUED BOOKS — books given from stock to a student, or — for an
 *    other-person order — to that person. A guarded `stock >= quantity`
 *    update keeps stock from going negative. Books issued for an order are
 *    limited to what that order received.
 *
 * Every write carries a client idempotency key (unique per academy): a
 * repeated submit returns the first record instead of a second. Every write
 * is audited.
 *
 * Permissions: the `academy.books` row; "manage" may order, take payments
 * and issue. Branch isolation: an order carries its buyer's branch (the
 * student's own branch, or the branch chosen for another person); members
 * limited to some branches see and act only on their branches' orders,
 * payments and issues. Another academy's ids always read as not found.
 */

export interface BookOrderError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "invalid_state";
  message: string;
}

const FORBIDDEN: BookOrderError = { code: "forbidden", message: "You don't have permission to manage book orders." };
const ORDER_NOT_FOUND: BookOrderError = { code: "not_found", message: "Order not found." };
const INCOME_CATEGORY = "book_order";

interface Access {
  academyId: string;
  membershipRole: AcademyRole;
  /** Create / receive / cancel orders and record payments. */
  canManageOrders: boolean;
  /** Issue books to students. */
  canIssue: boolean;
  scope: BranchScope;
}

async function resolveAccess(actorContext: AuthContext): Promise<{ ok: true; access: Access } | { ok: false; error: BookOrderError }> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_BOOKS_ACTION);
  if (level === "none") return { ok: false, error: { code: "forbidden", message: "You don't have permission to view book orders." } };
  return {
    ok: true,
    access: {
      academyId: access.academyId,
      membershipRole: access.membershipRole,
      canManageOrders: level === "manage",
      canIssue: level === "manage",
      scope: await getBranchScope(access, actorContext.userId),
    },
  };
}

function firstIssue(error: z.ZodError): BookOrderError {
  return { code: "validation", message: error.issues[0]?.message ?? "Invalid input." };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505";
}

/** Thrown inside a transaction to roll it back with a clean error. */
class Refused extends Error {
  constructor(readonly error: BookOrderError) {
    super(error.message);
  }
}

const isoDate = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a date.`)
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), `${label} must be a date.`)
    // One day of slack so "today" in a timezone ahead of UTC is accepted.
    .refine((value) => value <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), `${label} can't be in the future.`);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));

const idempotencyKey = z.string().uuid("Please try again.");

/** Same rule as a sale: fixed cents (capped at the subtotal) or a percentage. */
export function computeBookOrderPricing(subtotalCents: number, discountType: "none" | "fixed" | "percentage", discountValue: number) {
  const discountCents =
    discountType === "fixed" ? Math.min(discountValue, subtotalCents) : discountType === "percentage" ? Math.round((subtotalCents * discountValue) / 100) : 0;
  return { subtotalCents, discountCents, totalCents: Math.max(0, subtotalCents - discountCents) };
}

// ===========================================================================
// Orders
// ===========================================================================

/** An optional payment taken when the order is created (same rules as Record payment). */
const initialPaymentSchema = z.object({
  amountCents: z.number().int("Enter the amount in cents.").positive("The amount must be more than zero."),
  method: z.enum(BOOK_ORDER_PAYMENT_METHODS, { message: "Choose how the buyer paid." }),
  reference: optionalText(200),
  paidOn: isoDate("Payment date"),
});

export const createBookOrderSchema = z
  .object({
    buyerType: z.enum(["student", "other_person"], { message: "Choose who is buying these books." }),
    studentId: z.string().uuid("Choose a student.").optional(),
    buyerName: optionalText(200),
    buyerPhone: optionalText(50),
    buyerEmail: z
      .string()
      .trim()
      .max(200)
      .optional()
      .or(z.literal(""))
      .transform((value) => (value && value.length > 0 ? value.toLowerCase() : undefined))
      .refine((value) => value === undefined || z.string().email().safeParse(value).success, "Enter a valid email address, or leave it empty."),
    /** Money received now, saved with the order in one transaction. */
    payment: initialPaymentSchema.optional(),
    /** Another person's order: the branch it belongs to (a student's order uses the student's branch). */
    branchId: z.string().uuid("Choose a branch.").optional().or(z.literal("")).transform((v) => v || undefined),
    orderDate: isoDate("Order date"),
    notes: optionalText(1000),
    items: z
      .array(
        z.object({
          bookId: z.string().uuid("Choose a book."),
          quantity: z.number().int("Quantity must be a whole number.").min(1, "Quantity must be at least 1.").max(10_000),
        }),
      )
      .min(1, "Add at least one book.")
      .max(50),
    discountType: z.enum(["none", "fixed", "percentage"]).default("none"),
    discountValue: z.number().int("Enter a whole number.").min(0, "The discount can't be negative.").default(0),
    idempotencyKey,
  })
  .superRefine((data, ctx) => {
    if (data.buyerType === "student" && !data.studentId) ctx.addIssue({ code: "custom", message: "Choose a student.", path: ["studentId"] });
    if (data.buyerType === "other_person" && !data.buyerName) ctx.addIssue({ code: "custom", message: "Enter the buyer's name.", path: ["buyerName"] });
    if (data.discountType === "percentage" && data.discountValue > 100) ctx.addIssue({ code: "custom", message: "A percentage discount can't be more than 100." });
    const seen = new Set<string>();
    for (const item of data.items) {
      if (seen.has(item.bookId)) ctx.addIssue({ code: "custom", message: "Each book can appear only once on an order." });
      seen.add(item.bookId);
    }
  });

export type CreateBookOrderInput = z.input<typeof createBookOrderSchema>;
export type CreateBookOrderResult =
  | { ok: true; orderId: string; orderNumber: number; totalCents: number; paidCents: number; duplicate: boolean }
  | { ok: false; error: BookOrderError };

/**
 * Next order number for the academy. The advisory lock (released at commit)
 * serialises concurrent creates in one academy, so two orders never get the
 * same number; the unique index is the backstop.
 */
async function nextOrderNumber(tx: DbClient, academyId: string): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`book_order_number:${academyId}`}))`);
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(${bookOrders.orderNumber}), 0)::int` })
    .from(bookOrders)
    .where(eq(bookOrders.academyId, academyId));
  return Number(row?.n ?? 0) + 1;
}

/**
 * One buyer payment: its income row (category "book_order") and the payment
 * row, inside the caller's transaction. The caller has already checked the
 * amount against the outstanding balance.
 */
async function insertBuyerPayment(
  tx: DbClient,
  args: {
    academyId: string;
    order: { id: string; branchId: string | null; currency: string };
    buyer: string;
    amountCents: number;
    method: BookOrderPaymentMethod;
    reference: string | undefined;
    paidOn: string;
    idempotencyKey: string;
    userId: string;
  },
) {
  const [income] = await tx
    .insert(incomeRecords)
    .values({
      academyId: args.academyId,
      branchId: args.order.branchId,
      category: INCOME_CATEGORY,
      description: `Book order payment: ${args.buyer}`,
      amountCents: args.amountCents,
      currency: args.order.currency,
      recordedBy: args.userId,
    })
    .returning({ id: incomeRecords.id });
  const [payment] = await tx
    .insert(bookOrderPayments)
    .values({
      academyId: args.academyId,
      orderId: args.order.id,
      amountCents: args.amountCents,
      method: args.method,
      reference: args.reference ?? null,
      paidOn: args.paidOn,
      incomeRecordId: income.id,
      idempotencyKey: args.idempotencyKey,
      recordedBy: args.userId,
    })
    .returning({ id: bookOrderPayments.id });
  return { paymentId: payment.id, incomeRecordId: income.id };
}

export async function createBookOrder(actorContext: AuthContext, input: CreateBookOrderInput): Promise<CreateBookOrderResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, canManageOrders, scope } = resolved.access;
  if (!canManageOrders) return { ok: false, error: FORBIDDEN };
  const parsed = createBookOrderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const data = parsed.data;

  // A repeated submit (same key) returns the first order and never adds a
  // second order or a second first payment.
  const replay = async () => {
    const [existing] = await db
      .select({ id: bookOrders.id, orderNumber: bookOrders.orderNumber, totalCents: bookOrders.totalCents })
      .from(bookOrders)
      .where(and(eq(bookOrders.academyId, academyId), eq(bookOrders.idempotencyKey, data.idempotencyKey)));
    if (!existing) return null;
    const [paid] = await db
      .select({ cents: sql<number>`coalesce(sum(${bookOrderPayments.amountCents}), 0)::int` })
      .from(bookOrderPayments)
      .where(eq(bookOrderPayments.orderId, existing.id));
    return {
      ok: true,
      orderId: existing.id,
      orderNumber: existing.orderNumber,
      totalCents: existing.totalCents,
      paidCents: Number(paid?.cents ?? 0),
      duplicate: true,
    } as const;
  };
  const earlier = await replay();
  if (earlier) return earlier;

  try {
    return await db.transaction(async (tx) => {
      // The buyer and the order's branch.
      let branchId: string | null = null;
      let studentId: string | null = null;
      if (data.buyerType === "student") {
        const [student] = await tx
          .select({ id: students.id, branchId: students.branchId })
          .from(students)
          .where(and(eq(students.id, data.studentId!), eq(students.academyId, academyId)));
        if (!student || !inBranchScope(scope, student.branchId)) throw new Refused({ code: "not_found", message: "Student not found." });
        studentId = student.id;
        branchId = student.branchId;
      } else if (data.branchId) {
        const [branch] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.id, data.branchId), eq(branches.academyId, academyId)));
        if (!branch || !inBranchScope(scope, branch.id)) throw new Refused({ code: "not_found", message: "Branch not found." });
        branchId = branch.id;
      } else if (!scope.academyWide) {
        throw new Refused({ code: "validation", message: "Choose the branch for this order." });
      }

      // Lines at each book's current price (never the client's).
      const bookRows = await tx
        .select({ id: books.id, name: books.name, priceCents: books.priceCents, currency: books.currency, status: books.status })
        .from(books)
        .where(and(eq(books.academyId, academyId), inArray(books.id, data.items.map((item) => item.bookId))));
      if (bookRows.length !== data.items.length) throw new Refused({ code: "not_found", message: "Book not found." });
      if (bookRows.some((book) => book.status !== "active")) throw new Refused({ code: "invalid_state", message: "An inactive book can't be ordered." });
      const currencies = new Set(bookRows.map((book) => book.currency));
      if (currencies.size > 1) throw new Refused({ code: "validation", message: "Books priced in different currencies need separate orders." });
      const currency = bookRows[0].currency;
      const byId = new Map(bookRows.map((book) => [book.id, book]));
      const lines = data.items.map((item) => {
        const unitCostCents = byId.get(item.bookId)!.priceCents;
        return { bookId: item.bookId, quantity: item.quantity, unitCostCents, lineTotalCents: item.quantity * unitCostCents };
      });
      const pricing = computeBookOrderPricing(
        lines.reduce((sum, line) => sum + line.lineTotalCents, 0),
        data.discountType,
        data.discountValue,
      );
      if (!Number.isSafeInteger(pricing.subtotalCents) || pricing.subtotalCents > 2_000_000_000) {
        throw new Refused({ code: "validation", message: "The order total is too large." });
      }

      if (data.payment && data.payment.amountCents > pricing.totalCents) {
        throw new Refused({
          code: "validation",
          message: `The amount paid is more than the order total (${formatMoney(pricing.totalCents, currency)}).`,
        });
      }

      const orderNumber = await nextOrderNumber(tx, academyId);
      const [order] = await tx
        .insert(bookOrders)
        .values({
          academyId,
          orderNumber,
          buyerType: data.buyerType,
          studentId,
          buyerName: data.buyerType === "other_person" ? data.buyerName! : null,
          buyerPhone: data.buyerType === "other_person" ? (data.buyerPhone ?? null) : null,
          buyerEmail: data.buyerType === "other_person" ? (data.buyerEmail ?? null) : null,
          branchId,
          orderDate: data.orderDate,
          currency,
          subtotalCents: pricing.subtotalCents,
          discountCents: pricing.discountCents,
          totalCents: pricing.totalCents,
          notes: data.notes ?? null,
          idempotencyKey: data.idempotencyKey,
          createdBy: actorContext.userId,
        })
        .returning({ id: bookOrders.id });
      await tx.insert(bookOrderItems).values(lines.map((line) => ({ academyId, orderId: order.id, ...line })));
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "book_order.create",
          entityType: "book_order",
          entityId: order.id,
          branchId: branchId ?? undefined,
          after: { orderNumber, buyerType: data.buyerType, studentId, buyerName: data.buyerName, orderDate: data.orderDate, currency, ...pricing, items: lines },
        },
        tx,
      );

      let paidCents = 0;
      if (data.payment && data.payment.amountCents > 0) {
        const buyer = studentId ? await buyerLabel(tx, { studentId, buyerName: null, supplierName: null }) : data.buyerName!;
        const { paymentId, incomeRecordId } = await insertBuyerPayment(tx, {
          academyId,
          order: { id: order.id, branchId, currency },
          buyer,
          amountCents: data.payment.amountCents,
          method: data.payment.method,
          reference: data.payment.reference,
          paidOn: data.payment.paidOn,
          // The order's own key already makes the whole create idempotent.
          idempotencyKey: randomUUID(),
          userId: actorContext.userId,
        });
        paidCents = data.payment.amountCents;
        await recordAudit(
          {
            actorUserId: actorContext.userId,
            actorRole: membershipRole,
            academyId,
            action: "book_order.payment",
            entityType: "book_order_payment",
            entityId: paymentId,
            branchId: branchId ?? undefined,
            after: {
              orderId: order.id,
              amountCents: paidCents,
              method: data.payment.method,
              reference: data.payment.reference,
              paidOn: data.payment.paidOn,
              incomeRecordId,
              paidCents,
              outstandingCents: pricing.totalCents - paidCents,
              paymentStatus: bookOrderPaymentStatus(pricing.totalCents, paidCents),
              atCreate: true,
            },
          },
          tx,
        );
      }
      return { ok: true as const, orderId: order.id, orderNumber, totalCents: pricing.totalCents, paidCents, duplicate: false };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.error };
    if (isUniqueViolation(err)) {
      const raced = await replay();
      if (raced) return raced;
    }
    throw err;
  }
}

/** The order (locked) if it is this academy's and in the caller's branches. */
async function lockScopedOrder(executor: DbClient, access: Access, orderId: string) {
  if (!z.string().uuid().safeParse(orderId).success) return null;
  const [order] = await executor
    .select()
    .from(bookOrders)
    .where(and(eq(bookOrders.id, orderId), eq(bookOrders.academyId, access.academyId)))
    .for("update");
  // Rows without a buyer are old supplier orders (before 0052): kept as
  // history only, never part of the active workflow.
  if (!order || !order.buyerType || !inBranchScope(access.scope, order.branchId)) return null;
  return order;
}

export type SetBookOrderStatusResult = { ok: true; status: BookOrderStatus } | { ok: false; error: BookOrderError };

/**
 * Cancel a request that has no payments recorded and no books given. A
 * book order never changes stock, so there is no "received" step.
 */
export async function cancelBookOrder(actorContext: AuthContext, orderId: string): Promise<SetBookOrderStatusResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const access = resolved.access;
  if (!access.canManageOrders) return { ok: false, error: FORBIDDEN };

  try {
    return await db.transaction(async (tx) => {
      const order = await lockScopedOrder(tx, access, orderId);
      if (!order) throw new Refused(ORDER_NOT_FOUND);
      if (order.status === "cancelled") throw new Refused({ code: "invalid_state", message: "This order is already cancelled." });
      const [paid] = await tx.select({ n: sql<number>`count(*)::int` }).from(bookOrderPayments).where(eq(bookOrderPayments.orderId, order.id));
      if ((paid?.n ?? 0) > 0) throw new Refused({ code: "invalid_state", message: "This order has payments recorded, so it can't be cancelled." });
      const [arrived] = await tx.select({ n: sql<number>`count(*)::int` }).from(bookOrderReceipts).where(eq(bookOrderReceipts.orderId, order.id));
      if ((arrived?.n ?? 0) > 0) throw new Refused({ code: "invalid_state", message: "Books on this order were already received, so it can't be cancelled." });
      const [given] = await tx.select({ n: sql<number>`count(*)::int` }).from(bookIssues).where(eq(bookIssues.orderId, order.id));
      if ((given?.n ?? 0) > 0) throw new Refused({ code: "invalid_state", message: "Books were already given for this order, so it can't be cancelled." });
      await tx.update(bookOrders).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(bookOrders.id, order.id));
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: access.membershipRole,
          academyId: access.academyId,
          action: "book_order.cancel",
          entityType: "book_order",
          entityId: order.id,
          branchId: order.branchId ?? undefined,
          before: { status: order.status },
          after: { status: "cancelled" },
        },
        tx,
      );
      return { ok: true as const, status: "cancelled" as const };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.error };
    throw err;
  }
}

// ===========================================================================
// Payments from the buyer
// ===========================================================================

export const recordBookOrderPaymentSchema = z.object({
  orderId: z.string().uuid("Choose an order."),
  amountCents: z.number().int("Enter the amount in cents.").positive("The amount must be more than zero."),
  method: z.enum(BOOK_ORDER_PAYMENT_METHODS, { message: "Choose how the buyer paid." }),
  reference: optionalText(200),
  paidOn: isoDate("Payment date"),
  idempotencyKey,
});

export type RecordBookOrderPaymentInput = z.input<typeof recordBookOrderPaymentSchema>;
export type RecordBookOrderPaymentResult =
  | { ok: true; paymentId: string; paidCents: number; outstandingCents: number; paymentStatus: BookOrderPaymentStatus; duplicate: boolean }
  | { ok: false; error: BookOrderError };

export async function recordBookOrderPayment(actorContext: AuthContext, input: RecordBookOrderPaymentInput): Promise<RecordBookOrderPaymentResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const access = resolved.access;
  const { academyId, membershipRole, canManageOrders } = access;
  if (!canManageOrders) return { ok: false, error: FORBIDDEN };
  const parsed = recordBookOrderPaymentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const data = parsed.data;

  const position = async (executor: DbClient, orderId: string, totalCents: number) => {
    const [row] = await executor
      .select({ paid: sql<number>`coalesce(sum(${bookOrderPayments.amountCents}), 0)::int` })
      .from(bookOrderPayments)
      .where(eq(bookOrderPayments.orderId, orderId));
    const paidCents = Number(row?.paid ?? 0);
    return { paidCents, outstandingCents: Math.max(0, totalCents - paidCents), paymentStatus: bookOrderPaymentStatus(totalCents, paidCents) };
  };
  const replay = async () => {
    const [existing] = await db
      .select({ id: bookOrderPayments.id, orderId: bookOrderPayments.orderId, totalCents: bookOrders.totalCents })
      .from(bookOrderPayments)
      .innerJoin(bookOrders, eq(bookOrders.id, bookOrderPayments.orderId))
      .where(and(eq(bookOrderPayments.academyId, academyId), eq(bookOrderPayments.idempotencyKey, data.idempotencyKey)));
    if (!existing) return null;
    if (existing.orderId !== data.orderId) {
      return { ok: false, error: { code: "validation", message: "This payment was already submitted for another order. Please try again." } } as const;
    }
    return { ok: true, paymentId: existing.id, ...(await position(db, existing.orderId, existing.totalCents)), duplicate: true } as const;
  };
  const earlier = await replay();
  if (earlier) return earlier;

  try {
    return await db.transaction(async (tx) => {
      const order = await lockScopedOrder(tx, access, data.orderId);
      if (!order) throw new Refused(ORDER_NOT_FOUND);
      if (order.status === "cancelled") throw new Refused({ code: "invalid_state", message: "This order was cancelled; no payment can be recorded." });
      const before = await position(tx, order.id, order.totalCents);
      if (before.outstandingCents === 0) throw new Refused({ code: "validation", message: "This order is already fully paid." });
      if (data.amountCents > before.outstandingCents) {
        throw new Refused({
          code: "validation",
          message: `The amount is more than the outstanding balance (${formatMoney(before.outstandingCents, order.currency)}).`,
        });
      }
      const buyer = await buyerLabel(tx, order);
      const { paymentId, incomeRecordId } = await insertBuyerPayment(tx, {
        academyId,
        order,
        buyer,
        amountCents: data.amountCents,
        method: data.method,
        reference: data.reference,
        paidOn: data.paidOn,
        idempotencyKey: data.idempotencyKey,
        userId: actorContext.userId,
      });
      const after = await position(tx, order.id, order.totalCents);
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "book_order.payment",
          entityType: "book_order_payment",
          entityId: paymentId,
          branchId: order.branchId ?? undefined,
          after: { orderId: order.id, amountCents: data.amountCents, method: data.method, reference: data.reference, paidOn: data.paidOn, incomeRecordId, ...after },
        },
        tx,
      );
      return { ok: true as const, paymentId, ...after, duplicate: false };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.error };
    if (isUniqueViolation(err)) {
      const raced = await replay();
      if (raced) return raced;
    }
    throw err;
  }
}

async function buyerLabel(executor: DbClient, order: Pick<typeof bookOrders.$inferSelect, "studentId" | "buyerName" | "supplierName">): Promise<string> {
  if (order.studentId) {
    const [student] = await executor.select({ name: students.fullName }).from(students).where(eq(students.id, order.studentId));
    return student?.name ?? "student";
  }
  return order.buyerName ?? order.supplierName ?? "buyer";
}

// ===========================================================================
// Issuing books
// ===========================================================================

export const issueBooksSchema = z
  .object({
    /** Optional check: the request's student. */
    studentId: z.string().uuid("Choose a student.").optional(),
    /** The book request the books are given for (its buyer receives them). */
    orderId: z.string().uuid("Choose the order."),
    bookId: z.string().uuid("Choose a book."),
    quantity: z.number().int("Quantity must be a whole number.").min(1, "Quantity must be at least 1.").max(10_000),
    issuedOn: isoDate("Issue date"),
    notes: optionalText(500),
    idempotencyKey,
  })
;

export type IssueBooksInput = z.input<typeof issueBooksSchema>;
export type IssueBooksResult = { ok: true; issueId: string; stockLeft: number; duplicate: boolean } | { ok: false; error: BookOrderError };

export async function issueBooksToStudent(actorContext: AuthContext, input: IssueBooksInput): Promise<IssueBooksResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const access = resolved.access;
  const { academyId, membershipRole, canIssue, scope } = access;
  if (!canIssue) return { ok: false, error: { code: "forbidden", message: "You don't have permission to issue books." } };
  const parsed = issueBooksSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const data = parsed.data;

  const replay = async () => {
    const [existing] = await db
      .select({ id: bookIssues.id, stock: books.stockQuantity })
      .from(bookIssues)
      .innerJoin(books, eq(books.id, bookIssues.bookId))
      .where(and(eq(bookIssues.academyId, academyId), eq(bookIssues.idempotencyKey, data.idempotencyKey)));
    return existing ? ({ ok: true, issueId: existing.id, stockLeft: existing.stock, duplicate: true } as const) : null;
  };
  const earlier = await replay();
  if (earlier) return earlier;

  try {
    return await db.transaction(async (tx) => {
      let studentId: string | null = null;
      let recipientName: string | null = null;
      let branchId: string | null = null;
      let orderId: string | null = null;

      {
        // Books are given only for a request, to its buyer, once the request
        // is FULLY paid (the default rule; no partial-payment exception), and
        // never more than the request has left to give for this book.
        const order = await lockScopedOrder(tx, access, data.orderId);
        if (!order) throw new Refused(ORDER_NOT_FOUND);
        if (order.status === "cancelled") throw new Refused({ code: "invalid_state", message: "This order was cancelled." });
        const [paidRow] = await tx
          .select({ cents: sql<number>`coalesce(sum(${bookOrderPayments.amountCents}), 0)::int` })
          .from(bookOrderPayments)
          .where(eq(bookOrderPayments.orderId, order.id));
        const paidCents = Number(paidRow?.cents ?? 0);
        if (paidCents < order.totalCents) {
          throw new Refused({ code: "invalid_state", message: `This order isn't fully paid yet (${formatMoney(order.totalCents - paidCents, order.currency)} outstanding).` });
        }
        const [line] = await tx.select().from(bookOrderItems).where(and(eq(bookOrderItems.orderId, order.id), eq(bookOrderItems.bookId, data.bookId)));
        if (!line) throw new Refused({ code: "validation", message: "This book isn't on the order." });
        const [given] = await tx
          .select({ n: sql<number>`coalesce(sum(${bookIssues.quantity}), 0)::int` })
          .from(bookIssues)
          .where(and(eq(bookIssues.orderId, order.id), eq(bookIssues.bookId, data.bookId)));
        const left = line.quantity - Number(given?.n ?? 0);
        if (data.quantity > left) {
          throw new Refused({ code: "validation", message: left > 0 ? `Only ${left} left to give on this order.` : "Every copy on this order was already given." });
        }
        orderId = order.id;
        branchId = order.branchId;
        if (order.studentId) studentId = order.studentId;
        else recipientName = order.buyerName ?? order.supplierName;
        if (data.studentId && data.studentId !== studentId) throw new Refused({ code: "validation", message: "These books belong to the order's buyer." });
      }

      if (studentId) {
        const [student] = await tx
          .select({ id: students.id, branchId: students.branchId })
          .from(students)
          .where(and(eq(students.id, studentId), eq(students.academyId, academyId)));
        if (!student || !inBranchScope(scope, student.branchId)) throw new Refused({ code: "not_found", message: "Student not found." });
        branchId = student.branchId;
      }

      const [book] = await tx
        .select({ id: books.id, name: books.name, status: books.status, stock: books.stockQuantity })
        .from(books)
        .where(and(eq(books.id, data.bookId), eq(books.academyId, academyId)));
      if (!book) throw new Refused({ code: "not_found", message: "Book not found." });

      // Guarded decrement: only succeeds while enough copies are in stock.
      const [updated] = await tx
        .update(books)
        .set({ stockQuantity: sql`${books.stockQuantity} - ${data.quantity}`, updatedAt: new Date() })
        .where(and(eq(books.id, book.id), eq(books.academyId, academyId), gte(books.stockQuantity, data.quantity)))
        .returning({ stock: books.stockQuantity });
      if (!updated) {
        throw new Refused({ code: "validation", message: `Only ${book.stock} ${book.stock === 1 ? "copy" : "copies"} of ${book.name} in stock.` });
      }
      const [issue] = await tx
        .insert(bookIssues)
        .values({
          academyId,
          studentId,
          recipientName,
          orderId,
          bookId: book.id,
          quantity: data.quantity,
          issuedOn: data.issuedOn,
          issuedBy: actorContext.userId,
          notes: data.notes ?? null,
          idempotencyKey: data.idempotencyKey,
        })
        .returning({ id: bookIssues.id });
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "book_issue.create",
          entityType: "book_issue",
          entityId: issue.id,
          branchId: branchId ?? undefined,
          after: { studentId, recipientName, orderId, bookId: book.id, quantity: data.quantity, issuedOn: data.issuedOn, stockLeft: updated.stock },
        },
        tx,
      );
      return { ok: true as const, issueId: issue.id, stockLeft: updated.stock, duplicate: false };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.error };
    if (isUniqueViolation(err)) {
      const raced = await replay();
      if (raced) return raced;
    }
    throw err;
  }
}

// ===========================================================================
// Reads
// ===========================================================================

export interface BookOrderItemView {
  id: string;
  bookId: string;
  bookName: string;
  quantity: number;
  unitCostCents: number;
  lineTotalCents: number;
  /** Historical only (0054): copies once recorded as received on this line. */
  quantityReceived: number;
  /** Copies already given to the buyer for this line. */
  issuedQuantity: number;
}

export interface BookOrderPaymentView {
  id: string;
  amountCents: number;
  method: BookOrderPaymentMethod;
  reference: string | null;
  paidOn: string;
  recordedByLabel: string;
  createdAt: Date;
}

export interface BookOrderView {
  id: string;
  /** 1, 2, 3 ... per academy (0056). */
  orderNumber: number;
  buyerEmail: string | null;
  /** Null only for an order recorded before 0052 (a supplier order). */
  buyerType: "student" | "other_person" | null;
  studentId: string | null;
  /** The student's name, the other person's name, or the old supplier's name. */
  buyerName: string;
  studentNumber: string | null;
  buyerPhone: string | null;
  branchId: string | null;
  branchName: string | null;
  orderDate: string;
  status: BookOrderStatus;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  paidCents: number;
  outstandingCents: number;
  paymentStatus: BookOrderPaymentStatus;
  notes: string | null;
  copies: number;
  issuedCopies: number;
  receivedCopies: number;
  receipts: { id: string; bookName: string; quantity: number; receivedOn: string; note: string | null; receivedByLabel: string; createdAt: Date }[];
  items: BookOrderItemView[];
  payments: BookOrderPaymentView[];
  createdByLabel: string;
  createdAt: Date;
  receivedAt: Date | null;
  receivedByLabel: string | null;
}

export interface BookIssueView {
  id: string;
  studentId: string | null;
  /** The student's name, or the other person's name. */
  recipientName: string;
  studentNumber: string | null;
  orderId: string | null;
  bookId: string;
  bookName: string;
  quantity: number;
  issuedOn: string;
  issuedByLabel: string;
  notes: string | null;
  createdAt: Date;
}

export interface BookOrdersOverview {
  canManageOrders: boolean;
  canIssue: boolean;
  orders: BookOrderView[];
  issues: BookIssueView[];
}

export type GetBookOrdersOverviewResult = { ok: true; overview: BookOrdersOverview } | { ok: false; error: BookOrderError };

/** Orders (with lines and payments) and the issued-books history in the caller's branches. */
export async function getBookOrdersOverview(actorContext: AuthContext): Promise<GetBookOrdersOverviewResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, canManageOrders, canIssue, scope } = resolved.access;

  // Buyer orders only: rows without a buyer are old supplier orders (history).
  const orderConditions = [eq(bookOrders.academyId, academyId), isNotNull(bookOrders.buyerType)];
  const orderScope = branchScopeCondition(scope, bookOrders.branchId);
  if (orderScope) orderConditions.push(orderScope);
  const orderRows = await db
    .select({ order: bookOrders, studentName: students.fullName, studentNumber: students.studentNumber, branchName: branches.name })
    .from(bookOrders)
    .leftJoin(students, eq(students.id, bookOrders.studentId))
    .leftJoin(branches, eq(branches.id, bookOrders.branchId))
    .where(and(...orderConditions))
    .orderBy(desc(bookOrders.orderDate), desc(bookOrders.createdAt));
  const orderIds = orderRows.map((row) => row.order.id);
  const [itemRows, paymentRows, issuedRows, issues, receiptRows] = await Promise.all([
    orderIds.length
      ? db
          .select({ item: bookOrderItems, bookName: books.name })
          .from(bookOrderItems)
          .innerJoin(books, eq(books.id, bookOrderItems.bookId))
          .where(inArray(bookOrderItems.orderId, orderIds))
      : Promise.resolve([]),
    orderIds.length
      ? db.select().from(bookOrderPayments).where(inArray(bookOrderPayments.orderId, orderIds)).orderBy(desc(bookOrderPayments.paidOn), desc(bookOrderPayments.createdAt))
      : Promise.resolve([]),
    orderIds.length
      ? db
          .select({ orderId: bookIssues.orderId, bookId: bookIssues.bookId, n: sql<number>`sum(${bookIssues.quantity})::int` })
          .from(bookIssues)
          .where(inArray(bookIssues.orderId, orderIds))
          .groupBy(bookIssues.orderId, bookIssues.bookId)
      : Promise.resolve([]),
    loadIssues(academyId, scope),
    orderIds.length
      ? db
          .select({ receipt: bookOrderReceipts, bookName: books.name })
          .from(bookOrderReceipts)
          .innerJoin(books, eq(books.id, bookOrderReceipts.bookId))
          .where(inArray(bookOrderReceipts.orderId, orderIds))
          .orderBy(desc(bookOrderReceipts.createdAt))
      : Promise.resolve([]),
  ]);
  const labels = await resolveStaffLabels(academyId, [
    ...orderRows.map((row) => row.order.createdBy),
    ...orderRows.flatMap((row) => (row.order.receivedBy ? [row.order.receivedBy] : [])),
    ...paymentRows.map((payment) => payment.recordedBy),
    ...issues.map((row) => row.issuedBy),
    ...receiptRows.map((row) => row.receipt.receivedBy),
  ]);
  const label = (id: string) => labels.get(id) ?? "Staff member";
  const issuedOf = (orderId: string, bookId: string) => Number(issuedRows.find((row) => row.orderId === orderId && row.bookId === bookId)?.n ?? 0);

  const orders: BookOrderView[] = orderRows.map(({ order, studentName, studentNumber, branchName }) => {
    const items = itemRows
      .filter((row) => row.item.orderId === order.id)
      .map((row) => ({
        id: row.item.id,
        bookId: row.item.bookId,
        bookName: row.bookName,
        quantity: row.item.quantity,
        unitCostCents: row.item.unitCostCents,
        lineTotalCents: row.item.lineTotalCents,
        quantityReceived: row.item.quantityReceived,
        issuedQuantity: issuedOf(order.id, row.item.bookId),
      }))
      .sort((a, b) => a.bookName.localeCompare(b.bookName));
    const payments = paymentRows.filter((payment) => payment.orderId === order.id);
    const paidCents = payments.reduce((sum, payment) => sum + payment.amountCents, 0);
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      buyerEmail: order.buyerEmail,
      buyerType: order.buyerType,
      studentId: order.studentId,
      buyerName: studentName ?? order.buyerName ?? order.supplierName ?? "Buyer",
      studentNumber: studentNumber ?? null,
      buyerPhone: order.buyerPhone ?? order.supplierPhone,
      branchId: order.branchId,
      branchName: branchName ?? null,
      orderDate: order.orderDate,
      status: order.status,
      currency: order.currency,
      subtotalCents: order.subtotalCents || order.totalCents,
      discountCents: order.discountCents,
      totalCents: order.totalCents,
      paidCents,
      outstandingCents: Math.max(0, order.totalCents - paidCents),
      paymentStatus: bookOrderPaymentStatus(order.totalCents, paidCents),
      notes: order.notes,
      copies: items.reduce((sum, item) => sum + item.quantity, 0),
      issuedCopies: items.reduce((sum, item) => sum + item.issuedQuantity, 0),
      receivedCopies: items.reduce((sum, item) => sum + item.quantityReceived, 0),
      receipts: receiptRows
        .filter((row) => row.receipt.orderId === order.id)
        .map((row) => ({
          id: row.receipt.id,
          bookName: row.bookName,
          quantity: row.receipt.quantity,
          receivedOn: row.receipt.receivedOn,
          note: row.receipt.note,
          receivedByLabel: label(row.receipt.receivedBy),
          createdAt: row.receipt.createdAt,
        })),
      items,
      payments: payments.map((payment) => ({
        id: payment.id,
        amountCents: payment.amountCents,
        method: payment.method,
        reference: payment.reference,
        paidOn: payment.paidOn,
        recordedByLabel: label(payment.recordedBy),
        createdAt: payment.createdAt,
      })),
      createdByLabel: label(order.createdBy),
      createdAt: order.createdAt,
      receivedAt: order.receivedAt,
      receivedByLabel: order.receivedBy ? label(order.receivedBy) : null,
    };
  });

  return {
    ok: true,
    overview: { canManageOrders, canIssue, orders, issues: issues.map(({ issuedBy, ...rest }) => ({ ...rest, issuedByLabel: label(issuedBy) })) },
  };
}

/** Issues in the caller's branches: by the student's branch, or the order's for an other-person issue. */
async function loadIssues(academyId: string, scope: BranchScope, studentId?: string) {
  const conditions = [eq(bookIssues.academyId, academyId)];
  const scoped = branchScopeCondition(scope, sql`coalesce(${students.branchId}, ${bookOrders.branchId})`);
  if (scoped) conditions.push(scoped);
  if (studentId) conditions.push(eq(bookIssues.studentId, studentId));
  const rows = await db
    .select({
      id: bookIssues.id,
      studentId: bookIssues.studentId,
      studentName: students.fullName,
      studentNumber: students.studentNumber,
      otherName: bookIssues.recipientName,
      orderId: bookIssues.orderId,
      bookId: bookIssues.bookId,
      bookName: books.name,
      quantity: bookIssues.quantity,
      issuedOn: bookIssues.issuedOn,
      issuedBy: bookIssues.issuedBy,
      notes: bookIssues.notes,
      createdAt: bookIssues.createdAt,
    })
    .from(bookIssues)
    .leftJoin(students, and(eq(students.id, bookIssues.studentId), eq(students.academyId, academyId)))
    .leftJoin(bookOrders, eq(bookOrders.id, bookIssues.orderId))
    .innerJoin(books, eq(books.id, bookIssues.bookId))
    .where(and(...conditions))
    .orderBy(desc(bookIssues.issuedOn), desc(bookIssues.createdAt));
  return rows.map(({ studentName, otherName, ...rest }) => ({ ...rest, recipientName: studentName ?? otherName ?? "Recipient" }));
}

export type ListStudentBookIssuesResult = { ok: true; issues: BookIssueView[] } | { ok: false; error: BookOrderError };

/** The books issued to one student (student profile). Scoped like the history. */
export async function listStudentBookIssues(actorContext: AuthContext, studentId: string): Promise<ListStudentBookIssuesResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  if (!z.string().uuid().safeParse(studentId).success) return { ok: true, issues: [] };
  const { academyId, scope } = resolved.access;
  const rows = await loadIssues(academyId, scope, studentId);
  const labels = await resolveStaffLabels(academyId, rows.map((row) => row.issuedBy));
  return { ok: true, issues: rows.map(({ issuedBy, ...rest }) => ({ ...rest, issuedByLabel: labels.get(issuedBy) ?? "Staff member" })) };
}

// ===========================================================================
// Pickers for the order and issue forms
// ===========================================================================

export interface BookStudentOption {
  id: string;
  fullName: string;
  studentNumber: string;
  branchName: string;
  phone: string | null;
}

/** Active students of the caller's branches (managers only), for the order, sell and issue forms. */
export async function listBookStudentOptions(actorContext: AuthContext): Promise<{ ok: true; students: BookStudentOption[] } | { ok: false; error: BookOrderError }> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, canManageOrders, scope } = resolved.access;
  if (!canManageOrders) return { ok: true, students: [] };
  const conditions = [eq(students.academyId, academyId), eq(students.status, "active")];
  const scoped = branchScopeCondition(scope, students.branchId);
  if (scoped) conditions.push(scoped);
  const rows = await db
    .select({ id: students.id, fullName: students.fullName, studentNumber: students.studentNumber, branchName: branches.name, phone: students.phone })
    .from(students)
    .innerJoin(branches, eq(students.branchId, branches.id))
    .where(and(...conditions))
    .orderBy(students.fullName);
  return { ok: true, students: rows };
}

export interface BookBranchOption {
  id: string;
  name: string;
}

/** Active branches of the caller's scope, for an other-person order. */
export async function listBookBranchOptions(actorContext: AuthContext): Promise<{ ok: true; branches: BookBranchOption[] } | { ok: false; error: BookOrderError }> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, canManageOrders, scope } = resolved.access;
  if (!canManageOrders) return { ok: true, branches: [] };
  const conditions = [eq(branches.academyId, academyId), eq(branches.status, "active")];
  const scoped = branchScopeCondition(scope, branches.id);
  if (scoped) conditions.push(scoped);
  const rows = await db.select({ id: branches.id, name: branches.name }).from(branches).where(and(...conditions)).orderBy(branches.name);
  return { ok: true, branches: rows };
}

// ===========================================================================
// Changing an order's discount
// ===========================================================================

export const updateBookOrderDiscountSchema = z
  .object({
    orderId: z.string().uuid("Order not found."),
    discountType: z.enum(["none", "fixed", "percentage"]),
    discountValue: z.number().int("Enter a whole number.").min(0, "The discount can't be negative.").default(0),
  })
  .refine((data) => data.discountType !== "percentage" || data.discountValue <= 100, { message: "A percentage discount can't be more than 100." });

export type UpdateBookOrderDiscountInput = z.input<typeof updateBookOrderDiscountSchema>;
export type UpdateBookOrderDiscountResult =
  | { ok: true; subtotalCents: number; discountCents: number; totalCents: number; outstandingCents: number }
  | { ok: false; error: BookOrderError };

/**
 * Set or change an order's discount (fixed cents or a percentage of the
 * subtotal, the same rule as when it was created). The total is recomputed
 * from the saved subtotal. Refused on a cancelled order, and when the new
 * total would fall below what the buyer has already paid (no overpayment).
 */
export async function updateBookOrderDiscount(actorContext: AuthContext, input: UpdateBookOrderDiscountInput): Promise<UpdateBookOrderDiscountResult> {
  const resolved = await resolveAccess(actorContext);
  if (!resolved.ok) return resolved;
  const access = resolved.access;
  if (!access.canManageOrders) return { ok: false, error: FORBIDDEN };
  const parsed = updateBookOrderDiscountSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const data = parsed.data;

  try {
    return await db.transaction(async (tx) => {
      const order = await lockScopedOrder(tx, access, data.orderId);
      if (!order) throw new Refused(ORDER_NOT_FOUND);
      if (order.status === "cancelled") throw new Refused({ code: "invalid_state", message: "A cancelled order can't be changed." });
      if (!order.buyerType) throw new Refused({ code: "invalid_state", message: "This order can't take a discount." });
      const pricing = computeBookOrderPricing(order.subtotalCents, data.discountType, data.discountValue);
      const [paid] = await tx
        .select({ cents: sql<number>`coalesce(sum(${bookOrderPayments.amountCents}), 0)::int` })
        .from(bookOrderPayments)
        .where(eq(bookOrderPayments.orderId, order.id));
      const paidCents = Number(paid?.cents ?? 0);
      if (pricing.totalCents < paidCents) {
        throw new Refused({
          code: "validation",
          message: `The buyer has already paid ${formatMoney(paidCents, order.currency)}, so the total can't go below that.`,
        });
      }
      await tx.update(bookOrders).set({ discountCents: pricing.discountCents, totalCents: pricing.totalCents }).where(eq(bookOrders.id, order.id));
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: access.membershipRole,
          academyId: access.academyId,
          action: "book_order.discount",
          entityType: "book_order",
          entityId: order.id,
          branchId: order.branchId ?? undefined,
          before: { discountCents: order.discountCents, totalCents: order.totalCents },
          after: { discountType: data.discountType, discountValue: data.discountValue, discountCents: pricing.discountCents, totalCents: pricing.totalCents },
        },
        tx,
      );
      return { ok: true as const, ...pricing, outstandingCents: pricing.totalCents - paidCents };
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.error };
    throw err;
  }
}
