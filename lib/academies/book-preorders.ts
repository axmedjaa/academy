import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import {
  bookPreorderCampaignBooks,
  bookPreorderCampaigns,
  bookPreorderHandovers,
  bookPreorderItems,
  bookPreorderPayments,
  bookPreorderReceipts,
  bookPreorders,
  books,
  branches,
  incomeRecords,
  students,
} from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { branchScopeCondition, getBranchScope, inBranchScope, type BranchScope } from "@/lib/academies/branch-access";
import { resolveStaffLabels } from "@/lib/academies/staff-labels";
import { ACADEMY_BOOKS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";
import { formatMoney as formatCents } from "@/lib/ui/money";
import {
  CAMPAIGN_STATUSES,
  PREORDER_PAYMENT_METHODS,
  RECEIVABLE_STATUSES,
  availableToGive,
  computePreorderPricing,
  formatPreorderReference,
  maxGivable,
  preorderDistributionStatus,
  preorderPaymentStatus,
  referenceSequence,
  type CampaignStatus,
  type PreorderDistributionStatus,
  type PreorderPaymentMethod,
  type PreorderPaymentStatus,
} from "@/lib/academies/book-preorder-math";

/**
 * Book pre-orders (Book Management redesign, design B02-B09).
 *
 * A pre-order is demand for books that have NOT arrived. It is kept apart
 * from ordinary sales (lib/academies/book-sales.ts): creating an order,
 * paying for it, receiving the delivery and giving books to students never
 * reads or changes `books.stock_quantity`. Copies received for a campaign
 * form that campaign's own pool (usable = received - damaged), and books
 * are given to students only from that pool.
 *
 * Permissions: the same `academy.books` row as the catalogue and sales.
 * "manage" may create orders, record and verify payments and give books.
 * Campaigns and receiving affect every branch (one supplier delivery for
 * the whole academy), so — like the catalogue — they need all-branch
 * access; members limited to some branches see them read-only.
 *
 * Branch isolation: an order carries its student's branch. Members limited
 * to some branches see, pay and hand over only orders of those branches.
 * Campaign totals (copies ordered, received, given) are academy-wide
 * counts, because the pool and the optional limits are academy-wide.
 *
 * Money: amounts are integer cents and every total is recomputed here
 * from the saved lines (price snapshot per line). Each payment posts its
 * own income_records row (category "book_preorder") for exactly the amount
 * received, the same convention as book-sale payments. Verification is a
 * separate confirmation step and never changes an amount.
 *
 * Duplicates and races: each write takes a client idempotency key (unique
 * per academy) — a repeated submit returns the first result instead of a
 * second row. Rows that bound a limit are locked FOR UPDATE: the campaign
 * for order limits, the order for its balance, the campaign-book row for
 * the received pool, so two staff cannot over-give the same copies.
 */

export interface PreorderActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "conflict";
  message: string;
}

const FORBIDDEN: PreorderActionError = {
  code: "forbidden",
  message: "You don't have permission to manage book pre-orders.",
};
const NEEDS_ALL_BRANCHES: PreorderActionError = {
  code: "forbidden",
  message: "Campaigns and receiving affect every branch. Only staff with access to all branches can change them.",
};
const CAMPAIGN_NOT_FOUND: PreorderActionError = { code: "not_found", message: "Campaign not found." };
const ORDER_NOT_FOUND: PreorderActionError = { code: "not_found", message: "Order not found." };
const PAYMENT_NOT_FOUND: PreorderActionError = { code: "not_found", message: "Payment not found." };
const STUDENT_NOT_FOUND: PreorderActionError = { code: "not_found", message: "Student not found." };
const BRANCH_NOT_FOUND: PreorderActionError = { code: "not_found", message: "Branch not found." };

const INCOME_CATEGORY = "book_preorder";

interface PreorderAccess {
  academyId: string;
  membershipRole: AcademyRole;
  canManage: boolean;
  academyWide: boolean;
  scope: BranchScope;
}

type ResolveResult = { ok: true; access: PreorderAccess } | { ok: false; error: PreorderActionError };

async function resolvePreorderAccess(actorContext: AuthContext): Promise<ResolveResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") return { ok: false, error: { code: "blocked", message: access.message } };
  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_BOOKS_ACTION);
  if (level === "none") return { ok: false, error: { code: "forbidden", message: "You don't have permission to view book pre-orders." } };
  return {
    ok: true,
    access: {
      academyId: access.academyId,
      membershipRole: access.membershipRole,
      canManage: level === "manage",
      academyWide: access.academyWide,
      scope: await getBranchScope(access, actorContext.userId),
    },
  };
}

function firstIssue(error: z.ZodError): PreorderActionError {
  return { code: "validation", message: error.issues[0]?.message ?? "Invalid input." };
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ((err as { code?: unknown }).code === "23505") return true;
  const cause = (err as { cause?: unknown }).cause;
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "23505";
}

const isoDate = (label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a date.`)
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), `${label} must be a date.`);

const optionalNote = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));

/** Today as YYYY-MM-DD in UTC, plus one day of slack so a payment or
 * delivery dated "today" in a timezone ahead of UTC is still accepted. */
function latestAllowedDate(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ===========================================================================
// Campaigns
// ===========================================================================

export const campaignInputSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a campaign name.").max(200),
    opensOn: isoDate("Opening date"),
    closesOn: isoDate("Closing date"),
    expectedArrivalOn: isoDate("Expected arrival"),
    status: z.enum(CAMPAIGN_STATUSES),
    books: z
      .array(
        z.object({
          bookId: z.string().uuid("Invalid book."),
          quantityLimit: z.number().int("Limits must be whole numbers above 0, or left blank.").positive("Limits must be whole numbers above 0, or left blank.").nullable().optional(),
        }),
      )
      .min(1, "Select at least one book.")
      .max(200),
  })
  .refine((data) => data.closesOn >= data.opensOn, { message: "Closing date must be on or after opening.", path: ["closesOn"] })
  .refine((data) => data.expectedArrivalOn >= data.closesOn, { message: "Arrival must be on or after closing.", path: ["expectedArrivalOn"] })
  .refine((data) => new Set(data.books.map((b) => b.bookId)).size === data.books.length, { message: "A book is listed twice.", path: ["books"] });

export type CampaignInput = z.input<typeof campaignInputSchema>;

export type SaveCampaignResult = { ok: true; campaignId: string } | { ok: false; error: PreorderActionError };

/** Copies ordered per book of one campaign (all branches). */
async function campaignDemand(executor: DbClient, campaignId: string): Promise<Map<string, number>> {
  const rows = await executor
    .select({ bookId: bookPreorderItems.bookId, total: sql<string>`coalesce(sum(${bookPreorderItems.quantity}), 0)` })
    .from(bookPreorderItems)
    .innerJoin(bookPreorders, eq(bookPreorderItems.orderId, bookPreorders.id))
    .where(eq(bookPreorders.campaignId, campaignId))
    .groupBy(bookPreorderItems.bookId);
  return new Map(rows.map((row) => [row.bookId, Number(row.total)]));
}

/** Create (no `campaignId`) or update a campaign with its books and limits. */
export async function saveCampaign(actorContext: AuthContext, campaignId: string | null, input: CampaignInput): Promise<SaveCampaignResult> {
  const resolved = await resolvePreorderAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, canManage, academyWide } = resolved.access;
  if (!canManage) return { ok: false, error: FORBIDDEN };
  if (!academyWide) return { ok: false, error: NEEDS_ALL_BRANCHES };
  if (campaignId !== null && !z.string().uuid().safeParse(campaignId).success) return { ok: false, error: CAMPAIGN_NOT_FOUND };

  const parsed = campaignInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const bookIds = data.books.map((b) => b.bookId);
    const bookRows = await tx
      .select({ id: books.id, name: books.name, status: books.status })
      .from(books)
      .where(and(eq(books.academyId, academyId), inArray(books.id, bookIds)));
    if (bookRows.length !== bookIds.length) return { kind: "error" as const, error: { code: "not_found", message: "Book not found." } as PreorderActionError };

    let before: unknown = null;
    let id = campaignId;
    if (id) {
      const [existing] = await tx.select().from(bookPreorderCampaigns).where(eq(bookPreorderCampaigns.id, id)).for("update");
      if (!existing || existing.academyId !== academyId) return { kind: "error" as const, error: CAMPAIGN_NOT_FOUND };
      const currentBooks = await tx.select().from(bookPreorderCampaignBooks).where(eq(bookPreorderCampaignBooks.campaignId, id));
      before = { ...existing, books: currentBooks.map((b) => ({ bookId: b.bookId, quantityLimit: b.quantityLimit })) };

      const demand = await campaignDemand(tx, id);
      const nameOf = new Map(bookRows.map((b) => [b.id, b.name]));
      for (const current of currentBooks) {
        if (!bookIds.includes(current.bookId) && (demand.get(current.bookId) ?? 0) > 0) {
          const [book] = await tx.select({ name: books.name }).from(books).where(eq(books.id, current.bookId)).limit(1);
          return {
            kind: "error" as const,
            error: { code: "conflict", message: `${book?.name ?? "A book"} already has orders in this campaign and can't be removed.` } as PreorderActionError,
          };
        }
      }
      for (const entry of data.books) {
        const ordered = demand.get(entry.bookId) ?? 0;
        if (entry.quantityLimit && entry.quantityLimit < ordered) {
          return {
            kind: "error" as const,
            error: { code: "conflict", message: `The limit for ${nameOf.get(entry.bookId)} can't be below the ${ordered} copies already ordered.` } as PreorderActionError,
          };
        }
      }
      // A book archived after it joined the campaign may stay; a newly
      // added one must be active.
      const kept = new Set(currentBooks.map((b) => b.bookId));
      const archivedNew = bookRows.find((b) => b.status !== "active" && !kept.has(b.id));
      if (archivedNew) return { kind: "error" as const, error: { code: "validation", message: `${archivedNew.name} is archived and can't be added.` } as PreorderActionError };

      await tx
        .update(bookPreorderCampaigns)
        .set({ name: data.name, opensOn: data.opensOn, closesOn: data.closesOn, expectedArrivalOn: data.expectedArrivalOn, status: data.status, updatedAt: new Date() })
        .where(eq(bookPreorderCampaigns.id, id));
      const removed = currentBooks.filter((b) => !bookIds.includes(b.bookId)).map((b) => b.id);
      if (removed.length) await tx.delete(bookPreorderCampaignBooks).where(inArray(bookPreorderCampaignBooks.id, removed));
      for (const entry of data.books) {
        const existingRow = currentBooks.find((b) => b.bookId === entry.bookId);
        if (existingRow) {
          await tx.update(bookPreorderCampaignBooks).set({ quantityLimit: entry.quantityLimit ?? null }).where(eq(bookPreorderCampaignBooks.id, existingRow.id));
        } else {
          await tx.insert(bookPreorderCampaignBooks).values({ academyId, campaignId: id, bookId: entry.bookId, quantityLimit: entry.quantityLimit ?? null });
        }
      }
    } else {
      const archived = bookRows.find((b) => b.status !== "active");
      if (archived) return { kind: "error" as const, error: { code: "validation", message: `${archived.name} is archived and can't be added.` } as PreorderActionError };
      const [row] = await tx
        .insert(bookPreorderCampaigns)
        .values({ academyId, name: data.name, opensOn: data.opensOn, closesOn: data.closesOn, expectedArrivalOn: data.expectedArrivalOn, status: data.status, createdBy: actorContext.userId })
        .returning({ id: bookPreorderCampaigns.id });
      id = row.id;
      await tx.insert(bookPreorderCampaignBooks).values(data.books.map((entry) => ({ academyId, campaignId: row.id, bookId: entry.bookId, quantityLimit: entry.quantityLimit ?? null })));
    }

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: membershipRole,
        academyId,
        action: campaignId ? "updateBookPreorderCampaign" : "createBookPreorderCampaign",
        entityType: "book_preorder_campaign",
        entityId: id!,
        before: before ?? undefined,
        after: { ...data },
      },
      tx,
    );
    return { kind: "ok" as const, id: id! };
  });

  if (result.kind === "error") return { ok: false, error: result.error };
  return { ok: true, campaignId: result.id };
}

/** Open or close ordering (and any other status change) without editing
 * the rest of the campaign — the card's Open / Close Ordering button. */
export async function setCampaignStatus(actorContext: AuthContext, campaignId: string, status: CampaignStatus): Promise<SaveCampaignResult> {
  const resolved = await resolvePreorderAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, canManage, academyWide } = resolved.access;
  if (!canManage) return { ok: false, error: FORBIDDEN };
  if (!academyWide) return { ok: false, error: NEEDS_ALL_BRANCHES };
  if (!z.string().uuid().safeParse(campaignId).success) return { ok: false, error: CAMPAIGN_NOT_FOUND };
  if (!(CAMPAIGN_STATUSES as readonly string[]).includes(status)) return { ok: false, error: { code: "validation", message: "Invalid status." } };

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(bookPreorderCampaigns).where(eq(bookPreorderCampaigns.id, campaignId)).for("update");
    if (!existing || existing.academyId !== academyId) return null;
    if (existing.status !== status) {
      await tx.update(bookPreorderCampaigns).set({ status, updatedAt: new Date() }).where(eq(bookPreorderCampaigns.id, campaignId));
      await recordAudit(
        { actorUserId: actorContext.userId, actorRole: membershipRole, academyId, action: "setBookPreorderCampaignStatus", entityType: "book_preorder_campaign", entityId: campaignId, before: { status: existing.status }, after: { status } },
        tx,
      );
    }
    return campaignId;
  });
  if (!result) return { ok: false, error: CAMPAIGN_NOT_FOUND };
  return { ok: true, campaignId: result };
}

// ===========================================================================
// Student orders
// ===========================================================================

export const createPreorderSchema = z
  .object({
  idempotencyKey: z.string().uuid("Invalid request key."),
  campaignId: z.string().uuid("Choose an open campaign."),
  buyerType: z.enum(["student", "other_person"]).default("student"),
  /** Student orders. */
  studentId: z.string().uuid("Select a student.").optional(),
  /** Other-person orders: name required, phone optional, branch required. */
  buyerName: z.string().trim().max(200, "Name is too long.").optional(),
  buyerPhone: optionalNote(50),
  branchId: z.string().uuid("Choose a branch.").optional(),
  discountPercent: z.number().int("Enter a whole percentage between 0 and 100.").min(0, "Enter a percentage between 0 and 100.").max(100, "Enter a percentage between 0 and 100.").default(0),
  lines: z
    .array(
      z.object({
        bookId: z.string().uuid("Invalid book."),
        quantity: z.number().int("Quantity must be a whole number.").positive("Quantity must be at least 1.").max(1000, "Quantity is too large."),
      }),
    )
    .min(1, "Add at least one book.")
    .max(100)
    .refine((lines) => new Set(lines.map((l) => l.bookId)).size === lines.length, "A book is listed twice."),
  })
  .refine((data) => data.buyerType !== "student" || !!data.studentId, { message: "Select a student.", path: ["studentId"] })
  .refine((data) => data.buyerType !== "other_person" || !!data.buyerName?.trim(), { message: "Enter the buyer name.", path: ["buyerName"] })
  .refine((data) => data.buyerType !== "other_person" || !!data.branchId, { message: "Choose a branch.", path: ["branchId"] });

export type CreatePreorderInput = z.input<typeof createPreorderSchema>;
export type CreatePreorderResult =
  | { ok: true; orderId: string; reference: string; duplicate: boolean }
  | { ok: false; error: PreorderActionError };

export async function createPreorder(actorContext: AuthContext, input: CreatePreorderInput): Promise<CreatePreorderResult> {
  const resolved = await resolvePreorderAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, canManage, scope } = resolved.access;
  if (!canManage) return { ok: false, error: FORBIDDEN };

  const parsed = createPreorderSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const data = parsed.data;

  const findExisting = async () => {
    const [row] = await db
      .select({ id: bookPreorders.id, reference: bookPreorders.reference })
      .from(bookPreorders)
      .where(and(eq(bookPreorders.academyId, academyId), eq(bookPreorders.idempotencyKey, data.idempotencyKey)))
      .limit(1);
    return row ?? null;
  };
  const prior = await findExisting();
  if (prior) return { ok: true, orderId: prior.id, reference: prior.reference, duplicate: true };

  try {
    const result = await db.transaction(async (tx) => {
      // The buyer decides the order's branch: the student's own branch, or
      // the branch chosen for another person. Either must be in the
      // caller's academy and branch scope; nothing is taken on trust.
      let branchId: string;
      let studentId: string | null = null;
      if (data.buyerType === "student") {
        const [student] = await tx
          .select({ id: students.id, academyId: students.academyId, branchId: students.branchId, status: students.status })
          .from(students)
          .where(eq(students.id, data.studentId!))
          .limit(1);
        if (!student || student.academyId !== academyId || !inBranchScope(scope, student.branchId)) return { kind: "error" as const, error: STUDENT_NOT_FOUND };
        if (student.status !== "active") return { kind: "error" as const, error: { code: "validation", message: "This student is not active." } as PreorderActionError };
        branchId = student.branchId;
        studentId = student.id;
      } else {
        const [branch] = await tx
          .select({ id: branches.id, academyId: branches.academyId, status: branches.status })
          .from(branches)
          .where(eq(branches.id, data.branchId!))
          .limit(1);
        if (!branch || branch.academyId !== academyId || !inBranchScope(scope, branch.id)) return { kind: "error" as const, error: BRANCH_NOT_FOUND };
        if (branch.status !== "active") return { kind: "error" as const, error: { code: "validation", message: "This branch is not active." } as PreorderActionError };
        branchId = branch.id;
      }

      // Locking the campaign serializes orders of one campaign, so two staff
      // cannot both take the last copies under a limit.
      const [campaign] = await tx.select().from(bookPreorderCampaigns).where(eq(bookPreorderCampaigns.id, data.campaignId)).for("update");
      if (!campaign || campaign.academyId !== academyId) return { kind: "error" as const, error: CAMPAIGN_NOT_FOUND };
      if (campaign.status !== "open") return { kind: "error" as const, error: { code: "conflict", message: "This campaign is not open for orders." } as PreorderActionError };

      const campaignBooks = await tx.select().from(bookPreorderCampaignBooks).where(eq(bookPreorderCampaignBooks.campaignId, campaign.id));
      const bookRows = await tx
        .select({ id: books.id, name: books.name, priceCents: books.priceCents, currency: books.currency })
        .from(books)
        .where(and(eq(books.academyId, academyId), inArray(books.id, data.lines.map((l) => l.bookId))));
      const bookById = new Map(bookRows.map((b) => [b.id, b]));
      const demand = await campaignDemand(tx, campaign.id);

      for (const line of data.lines) {
        const book = bookById.get(line.bookId);
        const entry = campaignBooks.find((cb) => cb.bookId === line.bookId);
        if (!book || !entry) return { kind: "error" as const, error: { code: "validation", message: "A book on this order is not in the campaign." } as PreorderActionError };
        if (entry.quantityLimit !== null) {
          const left = entry.quantityLimit - (demand.get(line.bookId) ?? 0);
          if (line.quantity > left) {
            return {
              kind: "error" as const,
              error: { code: "conflict", message: left > 0 ? `Only ${left} more ${left === 1 ? "copy" : "copies"} of ${book.name} can be ordered.` : `${book.name} has reached its order limit.` } as PreorderActionError,
            };
          }
        }
      }
      const currencies = new Set(data.lines.map((l) => bookById.get(l.bookId)!.currency));
      if (currencies.size > 1) return { kind: "error" as const, error: { code: "validation", message: "All books on one order must use the same currency." } as PreorderActionError };
      const currency = [...currencies][0];

      const priced = data.lines.map((line) => ({ ...line, unitPriceCents: bookById.get(line.bookId)!.priceCents }));
      const pricing = computePreorderPricing(priced, data.discountPercent);

      // One reference sequence per academy and year, serialized by an
      // advisory lock scoped to this transaction.
      const year = new Date().getUTCFullYear();
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"book_preorder_ref:" + academyId}, 0))`);
      const refs = await tx
        .select({ reference: bookPreorders.reference })
        .from(bookPreorders)
        .where(and(eq(bookPreorders.academyId, academyId), sql`${bookPreorders.reference} like ${`PO-${year}-%`}`));
      const next = refs.reduce((max, row) => Math.max(max, referenceSequence(row.reference, year)), 0) + 1;
      const reference = formatPreorderReference(year, next);

      const [order] = await tx
        .insert(bookPreorders)
        .values({
          academyId,
          branchId,
          campaignId: campaign.id,
          buyerType: data.buyerType,
          studentId,
          buyerName: data.buyerType === "other_person" ? data.buyerName!.trim() : null,
          buyerPhone: data.buyerType === "other_person" ? (data.buyerPhone ?? null) : null,
          reference,
          currency,
          subtotalCents: pricing.subtotalCents,
          discountPercent: data.discountPercent,
          discountAmountCents: pricing.discountAmountCents,
          totalCents: pricing.totalCents,
          idempotencyKey: data.idempotencyKey,
          createdBy: actorContext.userId,
        })
        .returning();
      await tx.insert(bookPreorderItems).values(
        priced.map((line, index) => ({
          academyId,
          orderId: order.id,
          bookId: line.bookId,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          subtotalCents: pricing.lineSubtotals[index],
        })),
      );

      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "createBookPreorder",
          entityType: "book_preorder",
          entityId: order.id,
          after: { ...order, lines: priced },
        },
        tx,
      );
      return { kind: "ok" as const, orderId: order.id, reference };
    });
    if (result.kind === "error") return { ok: false, error: result.error };
    return { ok: true, orderId: result.orderId, reference: result.reference, duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = await findExisting();
      if (again) return { ok: true, orderId: again.id, reference: again.reference, duplicate: true };
    }
    throw err;
  }
}

// ===========================================================================
// Payments
// ===========================================================================

export const recordPreorderPaymentSchema = z.object({
  idempotencyKey: z.string().uuid("Invalid request key."),
  orderId: z.string().uuid("Choose an order first."),
  amountCents: z.number().int("Amount must be a whole number of cents.").positive("Enter an amount above 0."),
  method: z.enum(PREORDER_PAYMENT_METHODS),
  reference: optionalNote(200),
  paidOn: isoDate("Payment date"),
});

export type RecordPreorderPaymentInput = z.input<typeof recordPreorderPaymentSchema>;
export type RecordPreorderPaymentResult =
  | { ok: true; paymentId: string; balanceCents: number; duplicate: boolean }
  | { ok: false; error: PreorderActionError };

export async function recordPreorderPayment(actorContext: AuthContext, input: RecordPreorderPaymentInput): Promise<RecordPreorderPaymentResult> {
  const resolved = await resolvePreorderAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, canManage, scope } = resolved.access;
  if (!canManage) return { ok: false, error: FORBIDDEN };

  const parsed = recordPreorderPaymentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const data = parsed.data;
  if (data.paidOn > latestAllowedDate()) return { ok: false, error: { code: "validation", message: "Payment date can't be in the future." } };

  const findExisting = async () => {
    const [row] = await db
      .select({ id: bookPreorderPayments.id, orderId: bookPreorderPayments.orderId })
      .from(bookPreorderPayments)
      .where(and(eq(bookPreorderPayments.academyId, academyId), eq(bookPreorderPayments.idempotencyKey, data.idempotencyKey)))
      .limit(1);
    return row ?? null;
  };
  const balanceOf = async (orderId: string) => {
    const [order] = await db.select({ total: bookPreorders.totalCents }).from(bookPreorders).where(eq(bookPreorders.id, orderId)).limit(1);
    const [paid] = await db.select({ total: sql<string>`coalesce(sum(${bookPreorderPayments.amountCents}), 0)` }).from(bookPreorderPayments).where(eq(bookPreorderPayments.orderId, orderId));
    return Math.max(0, (order?.total ?? 0) - Number(paid?.total ?? 0));
  };
  const prior = await findExisting();
  if (prior) return { ok: true, paymentId: prior.id, balanceCents: await balanceOf(prior.orderId), duplicate: true };

  try {
    const result = await db.transaction(async (tx) => {
      const [order] = await tx.select().from(bookPreorders).where(eq(bookPreorders.id, data.orderId)).for("update");
      if (!order || order.academyId !== academyId || !inBranchScope(scope, order.branchId)) return { kind: "error" as const, error: ORDER_NOT_FOUND };

      const [paidRow] = await tx
        .select({ total: sql<string>`coalesce(sum(${bookPreorderPayments.amountCents}), 0)` })
        .from(bookPreorderPayments)
        .where(eq(bookPreorderPayments.orderId, order.id));
      const balance = order.totalCents - Number(paidRow?.total ?? 0);
      if (balance <= 0) return { kind: "error" as const, error: { code: "conflict", message: "This order is already paid in full." } as PreorderActionError };
      if (data.amountCents > balance) return { kind: "error" as const, error: { code: "conflict", message: `Amount is more than the remaining balance (${balance} cents).` } as PreorderActionError, balance };

      const [income] = await tx
        .insert(incomeRecords)
        .values({
          academyId,
          branchId: order.branchId,
          category: INCOME_CATEGORY,
          description: `Book pre-order payment: ${order.reference}`,
          amountCents: data.amountCents,
          currency: order.currency,
          recordedBy: actorContext.userId,
        })
        .returning({ id: incomeRecords.id });
      const [payment] = await tx
        .insert(bookPreorderPayments)
        .values({
          academyId,
          orderId: order.id,
          amountCents: data.amountCents,
          method: data.method,
          reference: data.reference,
          paidOn: data.paidOn,
          recordedBy: actorContext.userId,
          incomeRecordId: income.id,
          idempotencyKey: data.idempotencyKey,
        })
        .returning();

      const after = balance - data.amountCents;
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "recordBookPreorderPayment",
          entityType: "book_preorder",
          entityId: order.id,
          before: { balanceCents: balance },
          after: { paymentId: payment.id, amountCents: data.amountCents, method: data.method, balanceCents: after },
        },
        tx,
      );
      return { kind: "ok" as const, paymentId: payment.id, balance: after };
    });
    if (result.kind === "error") return { ok: false, error: result.error };
    return { ok: true, paymentId: result.paymentId, balanceCents: result.balance, duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = await findExisting();
      if (again) return { ok: true, paymentId: again.id, balanceCents: await balanceOf(again.orderId), duplicate: true };
    }
    throw err;
  }
}

export type VerifyPreorderPaymentResult = { ok: true } | { ok: false; error: PreorderActionError };

/** Confirms the money of one payment arrived. Idempotent: verifying an
 * already verified payment changes nothing. */
export async function verifyPreorderPayment(actorContext: AuthContext, paymentId: string): Promise<VerifyPreorderPaymentResult> {
  const resolved = await resolvePreorderAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, canManage, scope } = resolved.access;
  if (!canManage) return { ok: false, error: FORBIDDEN };
  if (!z.string().uuid().safeParse(paymentId).success) return { ok: false, error: PAYMENT_NOT_FOUND };

  const found = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ payment: bookPreorderPayments, branchId: bookPreorders.branchId })
      .from(bookPreorderPayments)
      .innerJoin(bookPreorders, eq(bookPreorderPayments.orderId, bookPreorders.id))
      .where(eq(bookPreorderPayments.id, paymentId))
      .for("update", { of: bookPreorderPayments });
    if (!row || row.payment.academyId !== academyId || !inBranchScope(scope, row.branchId)) return false;
    if (row.payment.verifiedAt) return true;
    await tx.update(bookPreorderPayments).set({ verifiedAt: new Date(), verifiedBy: actorContext.userId }).where(eq(bookPreorderPayments.id, paymentId));
    await recordAudit(
      { actorUserId: actorContext.userId, actorRole: membershipRole, academyId, action: "verifyBookPreorderPayment", entityType: "book_preorder", entityId: row.payment.orderId, after: { paymentId, amountCents: row.payment.amountCents } },
      tx,
    );
    return true;
  });
  return found ? { ok: true } : { ok: false, error: PAYMENT_NOT_FOUND };
}

// ===========================================================================
// Receiving
// ===========================================================================

export const recordReceiptSchema = z
  .object({
    idempotencyKey: z.string().uuid("Invalid request key."),
    campaignId: z.string().uuid("Choose a campaign."),
    bookId: z.string().uuid("Choose a book."),
    quantityReceived: z.number().int("Enter a whole number.").positive("Enter the quantity received.").max(100000),
    damagedQuantity: z.number().int("Enter a whole number.").min(0, "Enter 0 or more.").default(0),
    receivedOn: isoDate("Date received"),
    note: optionalNote(500),
  })
  .refine((data) => data.damagedQuantity <= data.quantityReceived, { message: "Damaged copies can't be more than the quantity received.", path: ["damagedQuantity"] });

export type RecordReceiptInput = z.input<typeof recordReceiptSchema>;
export type RecordReceiptResult = { ok: true; receiptId: string; duplicate: boolean } | { ok: false; error: PreorderActionError };

export async function recordPreorderReceipt(actorContext: AuthContext, input: RecordReceiptInput): Promise<RecordReceiptResult> {
  const resolved = await resolvePreorderAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, canManage, academyWide } = resolved.access;
  if (!canManage) return { ok: false, error: FORBIDDEN };
  if (!academyWide) return { ok: false, error: NEEDS_ALL_BRANCHES };

  const parsed = recordReceiptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const data = parsed.data;
  if (data.receivedOn > latestAllowedDate()) return { ok: false, error: { code: "validation", message: "Date received can't be in the future." } };

  const findExisting = async () => {
    const [row] = await db
      .select({ id: bookPreorderReceipts.id })
      .from(bookPreorderReceipts)
      .where(and(eq(bookPreorderReceipts.academyId, academyId), eq(bookPreorderReceipts.idempotencyKey, data.idempotencyKey)))
      .limit(1);
    return row ?? null;
  };
  const prior = await findExisting();
  if (prior) return { ok: true, receiptId: prior.id, duplicate: true };

  try {
    const result = await db.transaction(async (tx) => {
      const [campaign] = await tx.select().from(bookPreorderCampaigns).where(eq(bookPreorderCampaigns.id, data.campaignId)).limit(1);
      if (!campaign || campaign.academyId !== academyId) return { kind: "error" as const, error: CAMPAIGN_NOT_FOUND };
      if (!RECEIVABLE_STATUSES.includes(campaign.status)) {
        return { kind: "error" as const, error: { code: "conflict", message: `Books can't be received for a ${campaign.status} campaign.` } as PreorderActionError };
      }
      const [entry] = await tx
        .select()
        .from(bookPreorderCampaignBooks)
        .where(and(eq(bookPreorderCampaignBooks.campaignId, campaign.id), eq(bookPreorderCampaignBooks.bookId, data.bookId)))
        .for("update");
      if (!entry) return { kind: "error" as const, error: { code: "validation", message: "This book is not in the campaign." } as PreorderActionError };

      const [receipt] = await tx
        .insert(bookPreorderReceipts)
        .values({
          academyId,
          campaignId: campaign.id,
          bookId: data.bookId,
          quantityReceived: data.quantityReceived,
          damagedQuantity: data.damagedQuantity,
          receivedOn: data.receivedOn,
          note: data.note,
          recordedBy: actorContext.userId,
          idempotencyKey: data.idempotencyKey,
        })
        .returning();
      await recordAudit(
        { actorUserId: actorContext.userId, actorRole: membershipRole, academyId, action: "recordBookPreorderReceipt", entityType: "book_preorder_campaign", entityId: campaign.id, after: receipt },
        tx,
      );
      return { kind: "ok" as const, id: receipt.id };
    });
    if (result.kind === "error") return { ok: false, error: result.error };
    return { ok: true, receiptId: result.id, duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = await findExisting();
      if (again) return { ok: true, receiptId: again.id, duplicate: true };
    }
    throw err;
  }
}

// ===========================================================================
// Giving books to students
// ===========================================================================

export const givePreorderBooksSchema = z.object({
  idempotencyKey: z.string().uuid("Invalid request key."),
  orderId: z.string().uuid("Order not found."),
  bookId: z.string().uuid("Book not found."),
  quantity: z.number().int("Enter a whole number.").positive("Give at least 1 copy."),
});

export type GivePreorderBooksInput = z.input<typeof givePreorderBooksSchema>;
export type GivePreorderBooksResult =
  | { ok: true; handoverId: string; givenQuantity: number; duplicate: boolean }
  | { ok: false; error: PreorderActionError };

export async function givePreorderBooks(actorContext: AuthContext, input: GivePreorderBooksInput): Promise<GivePreorderBooksResult> {
  const resolved = await resolvePreorderAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, canManage, scope } = resolved.access;
  if (!canManage) return { ok: false, error: FORBIDDEN };

  const parsed = givePreorderBooksSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const data = parsed.data;

  const findExisting = async () => {
    const [row] = await db
      .select({ id: bookPreorderHandovers.id, itemId: bookPreorderHandovers.orderItemId })
      .from(bookPreorderHandovers)
      .where(and(eq(bookPreorderHandovers.academyId, academyId), eq(bookPreorderHandovers.idempotencyKey, data.idempotencyKey)))
      .limit(1);
    if (!row) return null;
    const [item] = await db.select({ given: bookPreorderItems.givenQuantity }).from(bookPreorderItems).where(eq(bookPreorderItems.id, row.itemId)).limit(1);
    return { id: row.id, given: item?.given ?? 0 };
  };
  const prior = await findExisting();
  if (prior) return { ok: true, handoverId: prior.id, givenQuantity: prior.given, duplicate: true };

  try {
    const result = await db.transaction(async (tx) => {
      // FOR SHARE on the order: a payment (which takes FOR UPDATE on the
      // same row) can't commit between the paid-in-full check below and
      // this handover, while two handovers can still run side by side.
      const [order] = await tx.select().from(bookPreorders).where(eq(bookPreorders.id, data.orderId)).for("share");
      if (!order || order.academyId !== academyId || !inBranchScope(scope, order.branchId)) return { kind: "error" as const, error: ORDER_NOT_FOUND };

      // Books are given only for orders paid in full with every payment
      // verified (client rule), for student and other-person orders alike.
      // There is no waiver, free-distribution or override path around this
      // check. A verification can only ever be added, never removed, so a
      // stale read here can only block, never wrongly allow.
      const [paidRow] = await tx
        .select({
          total: sql<string>`coalesce(sum(${bookPreorderPayments.amountCents}), 0)`,
          unverified: sql<string>`coalesce(sum(${bookPreorderPayments.amountCents}) filter (where ${bookPreorderPayments.verifiedAt} is null), 0)`,
        })
        .from(bookPreorderPayments)
        .where(eq(bookPreorderPayments.orderId, order.id));
      const outstanding = order.totalCents - Number(paidRow?.total ?? 0);
      const unverified = Number(paidRow?.unverified ?? 0);
      if (outstanding > 0) {
        return {
          kind: "error" as const,
          error: {
            code: "conflict",
            message: `This order is not fully paid: ${formatCents(outstanding, order.currency)} is still outstanding. Books can be given only after the full balance is paid and verified.`,
          } as PreorderActionError,
        };
      }
      if (unverified > 0) {
        return {
          kind: "error" as const,
          error: {
            code: "conflict",
            message: `This order is paid in full, but ${formatCents(unverified, order.currency)} of its payments is not verified yet. Books can be given only after every payment is verified.`,
          } as PreorderActionError,
        };
      }

      // Lock order: the campaign-book row first (the shared pool), then the
      // order line — every handover and every receipt of this book in this
      // campaign takes the same pool lock, so availability can't race.
      const [entry] = await tx
        .select()
        .from(bookPreorderCampaignBooks)
        .where(and(eq(bookPreorderCampaignBooks.campaignId, order.campaignId), eq(bookPreorderCampaignBooks.bookId, data.bookId)))
        .for("update");
      const [item] = await tx
        .select()
        .from(bookPreorderItems)
        .where(and(eq(bookPreorderItems.orderId, order.id), eq(bookPreorderItems.bookId, data.bookId)))
        .for("update");
      if (!entry || !item) return { kind: "error" as const, error: { code: "not_found", message: "This book is not on the order." } as PreorderActionError };

      const [received] = await tx
        .select({ usable: sql<string>`coalesce(sum(${bookPreorderReceipts.quantityReceived} - ${bookPreorderReceipts.damagedQuantity}), 0)` })
        .from(bookPreorderReceipts)
        .where(and(eq(bookPreorderReceipts.campaignId, order.campaignId), eq(bookPreorderReceipts.bookId, data.bookId)));
      const [handed] = await tx
        .select({ total: sql<string>`coalesce(sum(${bookPreorderHandovers.quantity}), 0)` })
        .from(bookPreorderHandovers)
        .where(and(eq(bookPreorderHandovers.campaignId, order.campaignId), eq(bookPreorderHandovers.bookId, data.bookId)));
      const pool = availableToGive(Number(received?.usable ?? 0), Number(handed?.total ?? 0));
      const max = maxGivable(item.quantity, item.givenQuantity, pool);
      if (item.givenQuantity >= item.quantity) return { kind: "error" as const, error: { code: "conflict", message: "Every copy of this book has already been given." } as PreorderActionError };
      if (max < 1) return { kind: "error" as const, error: { code: "conflict", message: "No undamaged copies of this book are available yet. Receive books first." } as PreorderActionError };
      if (data.quantity > max) {
        return { kind: "error" as const, error: { code: "conflict", message: `Only ${max} ${max === 1 ? "copy" : "copies"} can be given now.` } as PreorderActionError };
      }

      const [handover] = await tx
        .insert(bookPreorderHandovers)
        .values({
          academyId,
          orderId: order.id,
          orderItemId: item.id,
          campaignId: order.campaignId,
          bookId: data.bookId,
          quantity: data.quantity,
          givenBy: actorContext.userId,
          idempotencyKey: data.idempotencyKey,
        })
        .returning({ id: bookPreorderHandovers.id });
      const givenQuantity = item.givenQuantity + data.quantity;
      await tx.update(bookPreorderItems).set({ givenQuantity }).where(eq(bookPreorderItems.id, item.id));
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "giveBookPreorderBooks",
          entityType: "book_preorder",
          entityId: order.id,
          before: { bookId: data.bookId, givenQuantity: item.givenQuantity },
          after: { bookId: data.bookId, givenQuantity, handoverId: handover.id },
        },
        tx,
      );
      return { kind: "ok" as const, id: handover.id, givenQuantity };
    });
    if (result.kind === "error") return { ok: false, error: result.error };
    return { ok: true, handoverId: result.id, givenQuantity: result.givenQuantity, duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = await findExisting();
      if (again) return { ok: true, handoverId: again.id, givenQuantity: again.given, duplicate: true };
    }
    throw err;
  }
}

// ===========================================================================
// Reading
// ===========================================================================

export interface CampaignBookView {
  bookId: string;
  quantityLimit: number | null;
  /** Copies ordered across all branches. */
  ordered: number;
  received: number;
  damaged: number;
  usable: number;
  given: number;
  /** Copies in the pool not yet given: usable - given. */
  available: number;
}

export interface CampaignView {
  id: string;
  name: string;
  opensOn: string;
  closesOn: string;
  expectedArrivalOn: string;
  status: CampaignStatus;
  orderCount: number;
  books: CampaignBookView[];
}

export interface OrderItemView {
  id: string;
  bookId: string;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  givenQuantity: number;
}

export interface OrderPaymentView {
  id: string;
  orderId: string;
  amountCents: number;
  method: PreorderPaymentMethod;
  reference: string | null;
  paidOn: string;
  recordedByLabel: string;
  verified: boolean;
  verifiedByLabel: string | null;
  createdAt: Date;
}

export interface OrderHandoverView {
  id: string;
  orderId: string;
  bookId: string;
  quantity: number;
  givenByLabel: string;
  createdAt: Date;
}

export interface OrderView {
  id: string;
  reference: string;
  campaignId: string;
  buyerType: "student" | "other_person";
  /** The student's full name, or the other person's name. */
  buyerName: string;
  studentId: string | null;
  studentNumber: string | null;
  buyerPhone: string | null;
  branchId: string;
  branchName: string;
  currency: string;
  subtotalCents: number;
  discountPercent: number;
  discountAmountCents: number;
  totalCents: number;
  paidCents: number;
  unverifiedCents: number;
  balanceCents: number;
  copies: number;
  given: number;
  paymentStatus: PreorderPaymentStatus;
  distributionStatus: PreorderDistributionStatus;
  createdAt: Date;
  createdByLabel: string;
  items: OrderItemView[];
  payments: OrderPaymentView[];
  handovers: OrderHandoverView[];
}

export interface ReceiptView {
  id: string;
  campaignId: string;
  bookId: string;
  quantityReceived: number;
  damagedQuantity: number;
  receivedOn: string;
  note: string | null;
  recordedByLabel: string;
  createdAt: Date;
}

export interface PreorderStudentOption {
  id: string;
  fullName: string;
  studentNumber: string;
  branchName: string;
  phone: string | null;
}

export interface PreorderOverview {
  canManage: boolean;
  /** Campaign edits and receiving need all-branch access as well. */
  canManageCampaigns: boolean;
  campaigns: CampaignView[];
  orders: OrderView[];
  receipts: ReceiptView[];
}

export type GetPreorderOverviewResult = { ok: true; overview: PreorderOverview } | { ok: false; error: PreorderActionError };

/**
 * Everything the Book Management pages show for pre-orders, in one scoped
 * read: campaigns with academy-wide per-book totals, and the orders (with
 * lines, payments and handovers) of the caller's branches. Volumes per
 * academy are small (one row per student order), so totals are folded in
 * memory from a handful of grouped queries rather than per-row lookups.
 */
export async function getPreorderOverview(actorContext: AuthContext): Promise<GetPreorderOverviewResult> {
  const resolved = await resolvePreorderAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, canManage, academyWide, scope } = resolved.access;

  const orderScope = branchScopeCondition(scope, bookPreorders.branchId);
  const [campaignRows, campaignBookRows, demandRows, receiptRows, handedRows, orderCountRows, orderRows] = await Promise.all([
    db.select().from(bookPreorderCampaigns).where(eq(bookPreorderCampaigns.academyId, academyId)).orderBy(desc(bookPreorderCampaigns.opensOn)),
    db.select().from(bookPreorderCampaignBooks).where(eq(bookPreorderCampaignBooks.academyId, academyId)),
    db
      .select({ campaignId: bookPreorders.campaignId, bookId: bookPreorderItems.bookId, total: sql<string>`sum(${bookPreorderItems.quantity})` })
      .from(bookPreorderItems)
      .innerJoin(bookPreorders, eq(bookPreorderItems.orderId, bookPreorders.id))
      .where(eq(bookPreorders.academyId, academyId))
      .groupBy(bookPreorders.campaignId, bookPreorderItems.bookId),
    db.select().from(bookPreorderReceipts).where(eq(bookPreorderReceipts.academyId, academyId)).orderBy(desc(bookPreorderReceipts.receivedOn), desc(bookPreorderReceipts.createdAt)),
    db
      .select({ campaignId: bookPreorderHandovers.campaignId, bookId: bookPreorderHandovers.bookId, total: sql<string>`sum(${bookPreorderHandovers.quantity})` })
      .from(bookPreorderHandovers)
      .where(eq(bookPreorderHandovers.academyId, academyId))
      .groupBy(bookPreorderHandovers.campaignId, bookPreorderHandovers.bookId),
    db
      .select({ campaignId: bookPreorders.campaignId, count: sql<string>`count(*)` })
      .from(bookPreorders)
      .where(eq(bookPreorders.academyId, academyId))
      .groupBy(bookPreorders.campaignId),
    db
      .select({ order: bookPreorders, studentName: students.fullName, studentNumber: students.studentNumber, branchName: branches.name })
      .from(bookPreorders)
      .leftJoin(students, eq(bookPreorders.studentId, students.id))
      .innerJoin(branches, eq(bookPreorders.branchId, branches.id))
      .where(and(eq(bookPreorders.academyId, academyId), orderScope))
      .orderBy(desc(bookPreorders.createdAt)),
  ]);

  const orderIds = orderRows.map((row) => row.order.id);
  const [itemRows, paymentRows, handoverRows] = orderIds.length
    ? await Promise.all([
        db.select().from(bookPreorderItems).where(inArray(bookPreorderItems.orderId, orderIds)).orderBy(asc(bookPreorderItems.id)),
        db.select().from(bookPreorderPayments).where(inArray(bookPreorderPayments.orderId, orderIds)).orderBy(desc(bookPreorderPayments.paidOn), desc(bookPreorderPayments.createdAt)),
        db.select().from(bookPreorderHandovers).where(inArray(bookPreorderHandovers.orderId, orderIds)).orderBy(desc(bookPreorderHandovers.createdAt)),
      ])
    : [[], [], []];

  const labels = await resolveStaffLabels(academyId, [
    ...orderRows.map((row) => row.order.createdBy),
    ...paymentRows.flatMap((p) => (p.verifiedBy ? [p.recordedBy, p.verifiedBy] : [p.recordedBy])),
    ...handoverRows.map((h) => h.givenBy),
    ...receiptRows.map((r) => r.recordedBy),
  ]);
  const label = (id: string) => labels.get(id) ?? "Staff member";

  const key = (campaignId: string, bookId: string) => `${campaignId}:${bookId}`;
  const demand = new Map(demandRows.map((row) => [key(row.campaignId, row.bookId), Number(row.total)]));
  const handed = new Map(handedRows.map((row) => [key(row.campaignId, row.bookId), Number(row.total)]));
  const receivedBy = new Map<string, { received: number; damaged: number }>();
  for (const r of receiptRows) {
    const k = key(r.campaignId, r.bookId);
    const cur = receivedBy.get(k) ?? { received: 0, damaged: 0 };
    cur.received += r.quantityReceived;
    cur.damaged += r.damagedQuantity;
    receivedBy.set(k, cur);
  }
  const orderCounts = new Map(orderCountRows.map((row) => [row.campaignId, Number(row.count)]));

  const campaigns: CampaignView[] = campaignRows.map((c) => ({
    id: c.id,
    name: c.name,
    opensOn: c.opensOn,
    closesOn: c.closesOn,
    expectedArrivalOn: c.expectedArrivalOn,
    status: c.status,
    orderCount: orderCounts.get(c.id) ?? 0,
    books: campaignBookRows
      .filter((cb) => cb.campaignId === c.id)
      .map((cb) => {
        const k = key(c.id, cb.bookId);
        const rec = receivedBy.get(k) ?? { received: 0, damaged: 0 };
        const usable = rec.received - rec.damaged;
        const given = handed.get(k) ?? 0;
        return {
          bookId: cb.bookId,
          quantityLimit: cb.quantityLimit,
          ordered: demand.get(k) ?? 0,
          received: rec.received,
          damaged: rec.damaged,
          usable,
          given,
          available: availableToGive(usable, given),
        };
      }),
  }));

  const orders: OrderView[] = orderRows.map(({ order, studentName, studentNumber, branchName }) => {
    const items = itemRows
      .filter((i) => i.orderId === order.id)
      .map((i) => ({ id: i.id, bookId: i.bookId, quantity: i.quantity, unitPriceCents: i.unitPriceCents, subtotalCents: i.subtotalCents, givenQuantity: i.givenQuantity }));
    const payments = paymentRows
      .filter((p) => p.orderId === order.id)
      .map((p) => ({
        id: p.id,
        orderId: p.orderId,
        amountCents: p.amountCents,
        method: p.method,
        reference: p.reference,
        paidOn: p.paidOn,
        recordedByLabel: label(p.recordedBy),
        verified: p.verifiedAt !== null,
        verifiedByLabel: p.verifiedBy ? label(p.verifiedBy) : null,
        createdAt: p.createdAt,
      }));
    const handovers = handoverRows
      .filter((h) => h.orderId === order.id)
      .map((h) => ({ id: h.id, orderId: h.orderId, bookId: h.bookId, quantity: h.quantity, givenByLabel: label(h.givenBy), createdAt: h.createdAt }));
    const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
    const copies = items.reduce((sum, i) => sum + i.quantity, 0);
    const given = items.reduce((sum, i) => sum + i.givenQuantity, 0);
    return {
      id: order.id,
      reference: order.reference,
      campaignId: order.campaignId,
      buyerType: order.buyerType,
      buyerName: order.buyerType === "student" ? (studentName ?? "Student") : (order.buyerName ?? "Other person"),
      studentId: order.studentId,
      studentNumber: order.buyerType === "student" ? studentNumber : null,
      buyerPhone: order.buyerPhone,
      branchId: order.branchId,
      branchName,
      currency: order.currency,
      subtotalCents: order.subtotalCents,
      discountPercent: order.discountPercent,
      discountAmountCents: order.discountAmountCents,
      totalCents: order.totalCents,
      paidCents,
      unverifiedCents: payments.filter((p) => !p.verified).reduce((sum, p) => sum + p.amountCents, 0),
      balanceCents: Math.max(0, order.totalCents - paidCents),
      copies,
      given,
      paymentStatus: preorderPaymentStatus(order.totalCents, paidCents),
      distributionStatus: preorderDistributionStatus(copies, given),
      createdAt: order.createdAt,
      createdByLabel: label(order.createdBy),
      items,
      payments,
      handovers,
    };
  });

  const receipts: ReceiptView[] = receiptRows.map((r) => ({
    id: r.id,
    campaignId: r.campaignId,
    bookId: r.bookId,
    quantityReceived: r.quantityReceived,
    damagedQuantity: r.damagedQuantity,
    receivedOn: r.receivedOn,
    note: r.note,
    recordedByLabel: label(r.recordedBy),
    createdAt: r.createdAt,
  }));

  return { ok: true, overview: { canManage, canManageCampaigns: canManage && academyWide, campaigns, orders, receipts } };
}

/** Active students of the caller's branches, for the order form's picker.
 * Only for members who may create orders. */
export async function listPreorderStudentOptions(
  actorContext: AuthContext,
): Promise<{ ok: true; students: PreorderStudentOption[] } | { ok: false; error: PreorderActionError }> {
  const resolved = await resolvePreorderAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, canManage, scope } = resolved.access;
  if (!canManage) return { ok: true, students: [] };
  const rows = await db
    .select({ id: students.id, fullName: students.fullName, studentNumber: students.studentNumber, branchName: branches.name, phone: students.phone })
    .from(students)
    .innerJoin(branches, eq(students.branchId, branches.id))
    .where(and(eq(students.academyId, academyId), eq(students.status, "active"), branchScopeCondition(scope, students.branchId)))
    .orderBy(asc(students.fullName));
  return { ok: true, students: rows };
}

export interface PreorderBranchOption {
  id: string;
  name: string;
}

/** Active branches of the caller's scope, for an other-person order. */
export async function listPreorderBranchOptions(
  actorContext: AuthContext,
): Promise<{ ok: true; branches: PreorderBranchOption[] } | { ok: false; error: PreorderActionError }> {
  const resolved = await resolvePreorderAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, canManage, scope } = resolved.access;
  if (!canManage) return { ok: true, branches: [] };
  const rows = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(and(eq(branches.academyId, academyId), eq(branches.status, "active"), branchScopeCondition(scope, branches.id)))
    .orderBy(asc(branches.name));
  return { ok: true, branches: rows };
}
