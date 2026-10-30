import { and, asc, count, desc, eq, gte, ilike, inArray, lt, or, sql, sum, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  academies,
  academySubscriptions,
  subscriptionPayments,
  subscriptionPlans,
} from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * PLAN.md §5 Master Permission Matrix / lib/platform-staff/capabilities.ts:
 * recordSubscriptionPayment is the one grantable capability in this
 * workflow ("data entry only, not verification") — a platform_admin can be
 * granted it. verify/reject/reverse are already in UNGRANTABLE_CAPABILITIES
 * (lib/auth/permissions.ts), so hasPermission() returns true for those only
 * for platform_owner, no matter what a platform_admin has been granted.
 */
const RECORD_PAYMENT_CAPABILITY = "recordSubscriptionPayment";
const VERIFY_PAYMENT_CAPABILITY = "verifySubscriptionPayment";
const REJECT_PAYMENT_CAPABILITY = "rejectSubscriptionPayment";
const REVERSE_PAYMENT_CAPABILITY = "reverseSubscriptionPayment";

export interface PaymentActionError {
  code: "forbidden" | "validation" | "not_found" | "invalid_transition";
  message: string;
}

function forbiddenError(message: string): PaymentActionError {
  return { code: "forbidden", message };
}

async function requireCapability(
  actorContext: AuthContext,
  capability: string,
  message: string,
): Promise<PaymentActionError | null> {
  const allowed = await hasPermission(actorContext, capability);
  return allowed ? null : forbiddenError(message);
}

// PLAN.md's own column list (Phase 1 §2) for subscription_payments. See
// lib/db/schema.ts's comment on subscriptionPaymentStatusEnum for why
// payment_method is free text here (no exhaustive value list given anywhere
// in PLAN.md/DESIGN.md, unlike student_payments.method).
const recordPaymentInputSchema = z.object({
  academyId: z.string().uuid("A valid academy is required"),
  subscriptionId: z.string().uuid("A valid subscription is required"),
  amountCents: z
    .number()
    .int("Amount must be a whole number of cents")
    .nonnegative("Amount cannot be negative"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, "Currency must be a 3-letter code, e.g. USD"),
  paymentMethod: z.string().trim().min(1, "Payment method is required").max(100),
  paymentReference: z
    .string()
    .trim()
    .max(200)
    .optional()
    .nullable()
    .transform((value) => (value ? value : null)),
  // Evidence upload has no real storage backend yet (Cross-Cutting
  // Architecture Decisions — no lib/storage module exists this phase); this
  // is a plain optional file reference/key, never file bytes.
  evidenceFileRef: z
    .string()
    .trim()
    .max(500)
    .optional()
    .nullable()
    .transform((value) => (value ? value : null)),
  receivedAt: z.coerce.date({ message: "A valid received date is required" }),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .nullable()
    .transform((value) => (value ? value : null)),
});

export type RecordPaymentInput = z.input<typeof recordPaymentInputSchema>;

// DESIGN.md §8 /platform/payments: "Row actions: Verify / Reject / Reverse,
// each with a reason-required confirmation." Applied literally to all three
// — the reason is written onto that action's audit_logs row (the `reason`
// column, "administrative note/rejection reason") rather than onto
// subscription_payments itself, matching PLAN.md's literal column list for
// this table (see lib/db/schema.ts) which has no reason/rejection_reason
// column of its own.
const reasonInputSchema = z.object({
  reason: z.string().trim().min(1, "A reason is required").max(2000),
});

export type PaymentReasonInput = z.input<typeof reasonInputSchema>;

export interface SubscriptionPaymentRecord {
  id: string;
  academyId: string;
  subscriptionId: string;
  amountCents: number;
  currency: string;
  paymentMethod: string;
  paymentReference: string | null;
  evidenceFileRef: string | null;
  receivedAt: Date;
  recordedBy: string;
  verifiedBy: string | null;
  status: "pending" | "verified" | "rejected" | "reversed";
  notes: string | null;
  createdAt: Date;
}

function toRecord(
  row: typeof subscriptionPayments.$inferSelect,
): SubscriptionPaymentRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    subscriptionId: row.subscriptionId,
    amountCents: row.amountCents,
    currency: row.currency,
    paymentMethod: row.paymentMethod,
    paymentReference: row.paymentReference,
    evidenceFileRef: row.evidenceFileRef,
    receivedAt: row.receivedAt,
    recordedBy: row.recordedBy,
    verifiedBy: row.verifiedBy,
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt,
  };
}

/**
 * Lists every subscription payment (all statuses) for the /platform/payments
 * list view, newest first. Callers must already have checked
 * hasPermission(context, "recordSubscriptionPayment") themselves — this
 * helper does not re-check, matching listSubscriptionPlans()'s convention
 * (lib/subscriptions/plans.ts) of gating once at the page level.
 */
export interface RecentSubscriptionPaymentWithAcademy extends SubscriptionPaymentRecord {
  academyName: string | null;
}

/**
 * `limit` is for callers that only ever want the most recent N rows (e.g.
 * the platform dashboard's "Recent payments" panel) — passing it pushes
 * `ORDER BY created_at DESC LIMIT n` down to Postgres instead of fetching
 * every subscription payment the platform has ever recorded and slicing in
 * JS, which is what the dashboard used to do. Omit it (the default, used by
 * `/platform/payments`'s own full list) for unchanged behavior.
 *
 * The `limit` path also joins `academies` directly on
 * `subscription_payments.academy_id` (a real column on this table, not
 * something that needs resolving through `academy_subscriptions`) to
 * attach `academyName` to every row in the same query — one round trip,
 * always correct, no "most recent N academies" heuristic that could miss
 * a renewal payment on an older subscription (an earlier version of this
 * fix tried capping a *separate* name-lookup query instead, which could
 * resolve to `null` for any payment whose subscription wasn't among the
 * N most-recently-started ones; this replaces that with a single join).
 */
export async function listSubscriptionPayments(limit: number): Promise<RecentSubscriptionPaymentWithAcademy[]>;
export async function listSubscriptionPayments(limit?: undefined): Promise<SubscriptionPaymentRecord[]>;
export async function listSubscriptionPayments(
  limit?: number,
): Promise<SubscriptionPaymentRecord[] | RecentSubscriptionPaymentWithAcademy[]> {
  if (limit) {
    const rows = await db
      .select({ payment: subscriptionPayments, academyName: academies.name })
      .from(subscriptionPayments)
      .innerJoin(academies, eq(academies.id, subscriptionPayments.academyId))
      .orderBy(desc(subscriptionPayments.createdAt))
      .limit(limit);
    return rows.map((row) => ({ ...toRecord(row.payment), academyName: row.academyName }));
  }

  const rows = await db
    .select()
    .from(subscriptionPayments)
    .orderBy(subscriptionPayments.createdAt);

  return rows.map(toRecord).reverse();
}

export interface SubscriptionPaymentsPage {
  payments: SubscriptionPaymentRecord[];
  totalCount: number;
}

/**
 * Perf investigation (Afoogy slow-dashboard task, query-performance step):
 * same rows, same newest-first ordering `listSubscriptionPayments()`'s
 * no-limit overload already produces (there via fetch-all + `.reverse()`
 * in JS) — but for /platform/payments (app/platform/payments/page.tsx),
 * which only ever renders one `pageSize`-row slice and previously fetched
 * every payment row to get there. `ORDER BY createdAt DESC` expressed
 * directly (no JS reverse needed) plus `LIMIT`/`OFFSET` and a separate
 * `count(*)` for the page-nav total. Leaves `listSubscriptionPayments()`
 * itself untouched — its no-limit overload still has its own caller
 * (this file's own test) relying on the full, unpaginated list.
 */
export async function listSubscriptionPaymentsPage(
  page: number,
  pageSize: number,
): Promise<SubscriptionPaymentsPage> {
  const offset = Math.max(0, page - 1) * pageSize;

  const [rows, [{ value: totalCount }]] = await Promise.all([
    db
      .select()
      .from(subscriptionPayments)
      .orderBy(desc(subscriptionPayments.createdAt))
      .limit(pageSize)
      .offset(offset),
    db.select({ value: count() }).from(subscriptionPayments),
  ]);

  return { payments: rows.map(toRecord), totalCount };
}

export const SUBSCRIPTION_PAYMENT_STATUSES = ["pending", "verified", "rejected", "reversed"] as const;
export type SubscriptionPaymentStatusFilter = (typeof SUBSCRIPTION_PAYMENT_STATUSES)[number];

/** Filters for the /platform/payments list (design P07 filter bar). Every
 * field is optional; invalid values are dropped by `parsePaymentFilters`
 * before they reach the query. */
export interface SubscriptionPaymentFilters {
  /** Case-insensitive match on the payment id or the academy name. */
  search?: string;
  status?: SubscriptionPaymentStatusFilter;
  /** Exact recorded method. */
  method?: string;
  academyId?: string;
  /** Payments made against a subscription on this plan. */
  planId?: string;
  /** "YYYY-MM": payments received in that UTC calendar month (the dates
   * the table shows are UTC calendar dates, see lib/ui/date.ts). */
  month?: string;
}

const paymentFiltersSchema = z.object({
  search: z.string().trim().min(1).max(200).optional().catch(undefined),
  status: z.enum(SUBSCRIPTION_PAYMENT_STATUSES).optional().catch(undefined),
  method: z.string().trim().min(1).max(200).optional().catch(undefined),
  academyId: z.string().uuid().optional().catch(undefined),
  planId: z.string().uuid().optional().catch(undefined),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional()
    .catch(undefined),
});

/** URL search params -> filters. Unknown or malformed values are ignored
 * (an old or hand-edited link shows the unfiltered list, never an error). */
export function parsePaymentFilters(params: Record<string, string | string[] | undefined>): SubscriptionPaymentFilters {
  const first = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const parsed = paymentFiltersSchema.parse({
    search: first("q") || undefined,
    status: first("status") || undefined,
    method: first("method") || undefined,
    academyId: first("academy") || undefined,
    planId: first("plan") || undefined,
    month: first("month") || undefined,
  });
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) as SubscriptionPaymentFilters;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function paymentFilterWhere(filters: SubscriptionPaymentFilters): SQL | undefined {
  const conditions: SQL[] = [];
  if (filters.search) {
    const pattern = `%${escapeLike(filters.search)}%`;
    conditions.push(
      or(ilike(sql`${subscriptionPayments.id}::text`, pattern), ilike(academies.name, pattern)) as SQL,
    );
  }
  if (filters.status) conditions.push(eq(subscriptionPayments.status, filters.status));
  if (filters.method) conditions.push(eq(subscriptionPayments.paymentMethod, filters.method));
  if (filters.academyId) conditions.push(eq(subscriptionPayments.academyId, filters.academyId));
  if (filters.planId) conditions.push(eq(academySubscriptions.planId, filters.planId));
  if (filters.month) {
    const [year, month] = filters.month.split("-").map(Number);
    conditions.push(gte(subscriptionPayments.receivedAt, new Date(Date.UTC(year, month - 1, 1))));
    conditions.push(lt(subscriptionPayments.receivedAt, new Date(Date.UTC(year, month, 1))));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export interface FilteredSubscriptionPaymentsPage {
  payments: SubscriptionPaymentRecord[];
  /** Payments matching the filters, across all pages. */
  totalCount: number;
  /** Every payment, unfiltered ("Showing X of Y payments"). */
  overallCount: number;
  /** Verified amounts among the matching payments, per currency. */
  verifiedTotals: { currency: string; amountCents: number }[];
}

/**
 * One page of /platform/payments with the design P07 filters applied in
 * SQL, newest first — same ordering and LIMIT/OFFSET as
 * `listSubscriptionPaymentsPage`. Callers must already have checked the
 * page's own permission (recordSubscriptionPayment), as that page does.
 */
export async function listFilteredSubscriptionPaymentsPage(
  filters: SubscriptionPaymentFilters,
  page: number,
  pageSize: number,
): Promise<FilteredSubscriptionPaymentsPage> {
  const offset = Math.max(0, page - 1) * pageSize;
  const where = paymentFilterWhere(filters);

  const [rows, [{ value: totalCount }], [{ value: overallCount }], verifiedRows] = await Promise.all([
    db
      .select({ payment: subscriptionPayments })
      .from(subscriptionPayments)
      .innerJoin(academies, eq(academies.id, subscriptionPayments.academyId))
      .innerJoin(academySubscriptions, eq(academySubscriptions.id, subscriptionPayments.subscriptionId))
      .where(where)
      .orderBy(desc(subscriptionPayments.createdAt), desc(subscriptionPayments.id))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ value: count() })
      .from(subscriptionPayments)
      .innerJoin(academies, eq(academies.id, subscriptionPayments.academyId))
      .innerJoin(academySubscriptions, eq(academySubscriptions.id, subscriptionPayments.subscriptionId))
      .where(where),
    db.select({ value: count() }).from(subscriptionPayments),
    db
      .select({ currency: subscriptionPayments.currency, amountCents: sum(subscriptionPayments.amountCents) })
      .from(subscriptionPayments)
      .innerJoin(academies, eq(academies.id, subscriptionPayments.academyId))
      .innerJoin(academySubscriptions, eq(academySubscriptions.id, subscriptionPayments.subscriptionId))
      .where(and(eq(subscriptionPayments.status, "verified"), where))
      .groupBy(subscriptionPayments.currency)
      .orderBy(asc(subscriptionPayments.currency)),
  ]);

  return {
    payments: rows.map((row) => toRecord(row.payment)),
    totalCount,
    overallCount,
    verifiedTotals: verifiedRows.map((row) => ({ currency: row.currency, amountCents: Number(row.amountCents ?? 0) })),
  };
}

export interface SubscriptionPaymentFilterOptions {
  /** Distinct recorded methods, A to Z. */
  methods: string[];
  /** Academies that have at least one payment, A to Z. */
  academies: { id: string; name: string }[];
  /** Plans with at least one payment (through the paid subscription), A to Z. */
  plans: { id: string; name: string }[];
  /** "YYYY-MM" months that have payments (UTC), newest first. */
  months: string[];
}

/** Option lists for the P07 filter bar, built from the payments that exist
 * (design: "All methods" + each method present, "All academies" + each
 * academy with payments, "Any date" + months; plus "All plans" + each plan
 * that has payments). */
export async function getSubscriptionPaymentFilterOptions(): Promise<SubscriptionPaymentFilterOptions> {
  const monthExpr = sql<string>`to_char(${subscriptionPayments.receivedAt} at time zone 'UTC', 'YYYY-MM')`;
  const [methodRows, academyRows, planRows, monthRows] = await Promise.all([
    db
      .selectDistinct({ method: subscriptionPayments.paymentMethod })
      .from(subscriptionPayments)
      .orderBy(asc(subscriptionPayments.paymentMethod)),
    db
      .selectDistinct({ id: academies.id, name: academies.name })
      .from(subscriptionPayments)
      .innerJoin(academies, eq(academies.id, subscriptionPayments.academyId))
      .orderBy(asc(academies.name), asc(academies.id)),
    db
      .selectDistinct({ id: subscriptionPlans.id, name: subscriptionPlans.name })
      .from(subscriptionPayments)
      .innerJoin(academySubscriptions, eq(academySubscriptions.id, subscriptionPayments.subscriptionId))
      .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, academySubscriptions.planId))
      .orderBy(asc(subscriptionPlans.name), asc(subscriptionPlans.id)),
    db.selectDistinct({ month: monthExpr }).from(subscriptionPayments).orderBy(desc(monthExpr)),
  ]);
  return {
    methods: methodRows.map((row) => row.method),
    academies: academyRows,
    plans: planRows,
    months: monthRows.map((row) => row.month),
  };
}

export interface AcademySubscriptionOption {
  subscriptionId: string;
  academyId: string;
  academyName: string;
  planName: string;
  status: string;
}

/**
 * Picker data for the /platform/payments Record-Payment form's "academy,
 * subscription" fields (DESIGN.md §8) — every academy_subscriptions row
 * joined to its academy name and plan name for display. This lives here
 * (not in lib/academies/approve.ts or lib/subscriptions/plans.ts, both
 * off-limits for this item) since it's a read-only convenience query
 * specific to this form, not a mutation belonging to either of those
 * modules. Callers must already have checked
 * hasPermission(context, "recordSubscriptionPayment") themselves, same
 * convention as every other list* helper in this file.
 */
/**
 * `subscriptionIds`, when passed, narrows to just those rows. `limit`
 * (mutually exclusive with `subscriptionIds` — see the platform dashboard's
 * own call site) caps to the N most-recently-started subscriptions instead.
 *
 * Measured round-trip latency to this app's Postgres is ~217ms even for a
 * trivial query on an already-warm connection (query execution itself is
 * sub-millisecond — see lib/platform/dashboard.ts's own comment) — at that
 * latency, one extra *sequential* round trip costs far more than this query
 * returning a few hundred extra rows. So the platform dashboard's "Recent
 * payments" panel uses `limit`, not `subscriptionIds`: it can run in
 * parallel with the payments fetch instead of waiting for it, trading
 * perfect precision (an academy name could theoretically be missing for a
 * very old outlier payment, rendered as "—") for one fewer round trip.
 *
 * Omit both (the default) for the existing picker use case
 * (`/platform/payments`'s Record-Payment "academy, plan" select), which
 * genuinely needs every option — behavior there is unchanged.
 */
export async function listAcademySubscriptionOptions(
  options: { subscriptionIds?: string[]; limit?: number } = {},
): Promise<AcademySubscriptionOption[]> {
  const conditions = options.subscriptionIds ? [inArray(academySubscriptions.id, options.subscriptionIds)] : [];

  const query = db
    .select({
      subscriptionId: academySubscriptions.id,
      academyId: academySubscriptions.academyId,
      academyName: academies.name,
      planName: subscriptionPlans.name,
      status: academySubscriptions.status,
    })
    .from(academySubscriptions)
    .innerJoin(academies, eq(academies.id, academySubscriptions.academyId))
    .innerJoin(
      subscriptionPlans,
      eq(subscriptionPlans.id, academySubscriptions.planId),
    )
    .where(conditions.length > 0 ? conditions[0] : undefined)
    .orderBy(desc(academySubscriptions.startsAt));

  const rows = options.limit ? await query.limit(options.limit) : await query;

  return rows;
}

export type RecordSubscriptionPaymentResult =
  | { ok: true; payment: SubscriptionPaymentRecord }
  | { ok: false; error: PaymentActionError };

/**
 * PLAN.md §4: recordSubscriptionPayment (with evidence upload). Grantable to
 * platform_admin ("data entry only, not verification") — the row is always
 * created "pending"; only verifySubscriptionPayment/rejectSubscriptionPayment
 * (owner-only) move it out of that status.
 */
export async function recordSubscriptionPayment(
  actorContext: AuthContext,
  input: RecordPaymentInput,
): Promise<RecordSubscriptionPaymentResult> {
  const forbidden = await requireCapability(
    actorContext,
    RECORD_PAYMENT_CAPABILITY,
    "You don't have permission to record subscription payments.",
  );
  if (forbidden) return { ok: false, error: forbidden };

  const parsed = recordPaymentInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsed.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }
  const data = parsed.data;

  // Defensive integrity check (not explicitly required by PLAN.md's column
  // list, but implied by academy_id and subscription_id both being present
  // on the same row): the chosen subscription must actually belong to the
  // chosen academy, so a payment can never be recorded against a mismatched
  // pair via a tampered form submission.
  const [subscription] = await db
    .select({ academyId: academySubscriptions.academyId })
    .from(academySubscriptions)
    .where(eq(academySubscriptions.id, data.subscriptionId))
    .limit(1);

  if (!subscription) {
    return {
      ok: false,
      error: { code: "not_found", message: "Subscription not found." },
    };
  }
  if (subscription.academyId !== data.academyId) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: "That subscription does not belong to the selected academy.",
      },
    };
  }

  const payment = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(subscriptionPayments)
      .values({
        academyId: data.academyId,
        subscriptionId: data.subscriptionId,
        amountCents: data.amountCents,
        currency: data.currency,
        paymentMethod: data.paymentMethod,
        paymentReference: data.paymentReference,
        evidenceFileRef: data.evidenceFileRef,
        receivedAt: data.receivedAt,
        recordedBy: actorContext.userId,
        notes: data.notes,
      })
      .returning();

    // Same-transaction audit write (Cross-Cutting Architecture Decisions:
    // "the audit write happens in the same database transaction as the
    // mutation it protects").
    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: data.academyId,
        action: "recordSubscriptionPayment",
        entityType: "subscription_payment",
        entityId: row.id,
        after: {
          amountCents: data.amountCents,
          currency: data.currency,
          paymentMethod: data.paymentMethod,
          status: "pending",
        },
      },
      tx,
    );

    return row;
  });

  return { ok: true, payment: toRecord(payment) };
}

export type VerifySubscriptionPaymentResult =
  | { ok: true; payment: SubscriptionPaymentRecord }
  | { ok: false; error: PaymentActionError };

/**
 * PLAN.md §4/§5: verifySubscriptionPayment, platform_owner-only (never
 * grantable). Row-locks the target row (Planning Gaps Resolution §15 /
 * PLAN.md's Concurrency table: "Payment verification... row-locked status
 * check — two concurrent calls on the same row: one succeeds, one gets a
 * clear 'already processed' error").
 *
 * Deliberately does NOT touch academy_subscriptions.status. PLAN.md's
 * onboarding sequence (Phase 1 §2, "Onboarding, end to end") lists
 * verifySubscriptionPayment as step (5) and activateAcademy — a separate,
 * later, checklist-gated call — as step (8), the one that actually
 * "transitions the subscription per the table above"; the state machine's
 * own transition table (lib/subscriptions/state-machine.ts) names
 * renewSubscription, never verifySubscriptionPayment, as the Actor for
 * every Past Due/Suspended/Expired -> Active row. Folding a subscription
 * transition into this action would duplicate activateAcademy's (Item 26)
 * and renewSubscription's (Item 30) own responsibility and risk a double
 * transition — out of scope here by design, not an oversight.
 */
export async function verifySubscriptionPayment(
  actorContext: AuthContext,
  paymentId: string,
  input: PaymentReasonInput,
): Promise<VerifySubscriptionPaymentResult> {
  const forbidden = await requireCapability(
    actorContext,
    VERIFY_PAYMENT_CAPABILITY,
    "Only the platform owner can verify subscription payments.",
  );
  if (forbidden) return { ok: false, error: forbidden };

  const parsedPaymentId = z.string().uuid("A valid payment is required").safeParse(paymentId);
  if (!parsedPaymentId.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsedPaymentId.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }

  const parsed = reasonInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsed.error.issues[0]?.message ?? "A reason is required.",
      },
    };
  }
  const { reason } = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.id, paymentId))
      .for("update");

    if (!existing) {
      return { outcome: "not_found" as const };
    }
    if (existing.status !== "pending") {
      return { outcome: "already_processed" as const, existing };
    }

    const [updated] = await tx
      .update(subscriptionPayments)
      .set({ status: "verified", verifiedBy: actorContext.userId })
      .where(eq(subscriptionPayments.id, paymentId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: existing.academyId,
        action: "verifySubscriptionPayment",
        entityType: "subscription_payment",
        entityId: paymentId,
        before: { status: existing.status },
        after: { status: "verified" },
        reason,
      },
      tx,
    );

    return { outcome: "ok" as const, row: updated };
  });

  if (result.outcome === "not_found") {
    return {
      ok: false,
      error: { code: "not_found", message: "Payment not found." },
    };
  }
  if (result.outcome === "already_processed") {
    return {
      ok: false,
      error: {
        code: "invalid_transition",
        message: `This payment has already been ${result.existing.status} — it can no longer be verified.`,
      },
    };
  }

  return { ok: true, payment: toRecord(result.row) };
}

export type RejectSubscriptionPaymentResult =
  | { ok: true; payment: SubscriptionPaymentRecord }
  | { ok: false; error: PaymentActionError };

/**
 * PLAN.md §4/§5: rejectSubscriptionPayment, platform_owner-only (never
 * grantable). Only legal from "pending" — a verified payment is reversed,
 * never rejected (rejection means "this was never a real/valid payment,"
 * whereas reversal means "this real payment must stop being honored,"
 * mirroring the same pending/approved split PLAN.md draws for
 * student_payments in Phase 2, DESIGN.md §11's status table: "rejected
 * (reason required)" from pending, "reversed... from approved only").
 */
export async function rejectSubscriptionPayment(
  actorContext: AuthContext,
  paymentId: string,
  input: PaymentReasonInput,
): Promise<RejectSubscriptionPaymentResult> {
  const forbidden = await requireCapability(
    actorContext,
    REJECT_PAYMENT_CAPABILITY,
    "Only the platform owner can reject subscription payments.",
  );
  if (forbidden) return { ok: false, error: forbidden };

  const parsedPaymentId = z.string().uuid("A valid payment is required").safeParse(paymentId);
  if (!parsedPaymentId.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsedPaymentId.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }

  const parsed = reasonInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsed.error.issues[0]?.message ?? "A reason is required.",
      },
    };
  }
  const { reason } = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.id, paymentId))
      .for("update");

    if (!existing) {
      return { outcome: "not_found" as const };
    }
    if (existing.status !== "pending") {
      return { outcome: "already_processed" as const, existing };
    }

    const [updated] = await tx
      .update(subscriptionPayments)
      .set({ status: "rejected" })
      .where(eq(subscriptionPayments.id, paymentId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: existing.academyId,
        action: "rejectSubscriptionPayment",
        entityType: "subscription_payment",
        entityId: paymentId,
        before: { status: existing.status },
        after: { status: "rejected" },
        reason,
      },
      tx,
    );

    return { outcome: "ok" as const, row: updated };
  });

  if (result.outcome === "not_found") {
    return {
      ok: false,
      error: { code: "not_found", message: "Payment not found." },
    };
  }
  if (result.outcome === "already_processed") {
    return {
      ok: false,
      error: {
        code: "invalid_transition",
        message: `This payment has already been ${result.existing.status} — it can no longer be rejected.`,
      },
    };
  }

  return { ok: true, payment: toRecord(result.row) };
}

export type ReverseSubscriptionPaymentResult =
  | { ok: true; payment: SubscriptionPaymentRecord }
  | { ok: false; error: PaymentActionError };

/**
 * PLAN.md §4/§5: reverseSubscriptionPayment, platform_owner-only (never
 * grantable). Only legal from "verified" — matches Phase 1 §6's
 * renewSubscription precondition text ("verify it is status = Verified and
 * not reversed"), which requires reversed to be reachable only from
 * verified. Flips status in place (append-only row, no linked reversal row
 * — see lib/db/schema.ts's comment on this table). Once reversed, a payment
 * can never fund a renewSubscription call (Item 30's job to enforce, not
 * this file's — this action only ever changes this row's own status).
 */
export async function reverseSubscriptionPayment(
  actorContext: AuthContext,
  paymentId: string,
  input: PaymentReasonInput,
): Promise<ReverseSubscriptionPaymentResult> {
  const forbidden = await requireCapability(
    actorContext,
    REVERSE_PAYMENT_CAPABILITY,
    "Only the platform owner can reverse subscription payments.",
  );
  if (forbidden) return { ok: false, error: forbidden };

  const parsedPaymentId = z.string().uuid("A valid payment is required").safeParse(paymentId);
  if (!parsedPaymentId.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsedPaymentId.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }

  const parsed = reasonInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsed.error.issues[0]?.message ?? "A reason is required.",
      },
    };
  }
  const { reason } = parsed.data;

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.id, paymentId))
      .for("update");

    if (!existing) {
      return { outcome: "not_found" as const };
    }
    if (existing.status !== "verified") {
      return { outcome: "already_processed" as const, existing };
    }

    const [updated] = await tx
      .update(subscriptionPayments)
      .set({ status: "reversed" })
      .where(eq(subscriptionPayments.id, paymentId))
      .returning();

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: existing.academyId,
        action: "reverseSubscriptionPayment",
        entityType: "subscription_payment",
        entityId: paymentId,
        before: { status: existing.status },
        after: { status: "reversed" },
        reason,
      },
      tx,
    );

    return { outcome: "ok" as const, row: updated };
  });

  if (result.outcome === "not_found") {
    return {
      ok: false,
      error: { code: "not_found", message: "Payment not found." },
    };
  }
  if (result.outcome === "already_processed") {
    return {
      ok: false,
      error: {
        code: "invalid_transition",
        message: reverseRejectionMessage(result.existing.status),
      },
    };
  }

  return { ok: true, payment: toRecord(result.row) };
}

function reverseRejectionMessage(status: string): string {
  if (status === "pending") {
    return "This payment hasn't been verified yet — verify it before reversing.";
  }
  return `This payment has already been ${status} — it can no longer be reversed.`;
}
