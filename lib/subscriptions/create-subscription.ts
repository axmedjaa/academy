import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbClient } from "@/lib/db";
import { academySubscriptions, subscriptionPlans } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { initialSubscriptionStatus, type SubscriptionStatus } from "./state-machine";

/**
 * PLAN.md Phase 1 §6 state-transition table, `Draft -> Trial` row: "Plan
 * assigned, trial period starts | platform_owner (via createAcademySubscription)".
 * This is Item 24's own function — the first caller is `registerAcademy`
 * (lib/academies/register.ts), but the state-transition table's `Cancelled`
 * row ("Resuming service requires a NEW academy_subscriptions row via
 * createAcademySubscription") names this same function as the mechanism a
 * later item (not in scope here) will reuse to resume a cancelled academy —
 * hence a standalone, framework-agnostic module rather than logic inlined
 * into register.ts.
 *
 * Deliberately takes an `executor: DbClient` (matching recordAudit's own
 * shape) rather than opening its own transaction: PLAN.md's cross-cutting
 * rule is "the audit write happens in the same database transaction as the
 * mutation it protects", and registerAcademy already runs everything in one
 * `db.transaction`. Callers are responsible for their own permission check —
 * `createAcademySubscription` is deliberately absent from
 * UNGRANTABLE_CAPABILITIES (lib/auth/permissions.ts) because it has no
 * capability of its own: it is only ever reached through an already-gated
 * action (`registerAcademy` today), the same way recordAudit() never
 * re-checks permissions either.
 */

// z.input stays a FormData-friendly string (mirrors registerAcademySchema's
// optionalText fields) so a raw <form> submission and a direct programmatic
// call both work with the same shape; z.output is the parsed number/uuid.
const optionalTrialDays = z
  .string()
  .trim()
  .max(10)
  .optional()
  .or(z.literal(""))
  .transform((value) => (value && value.length > 0 ? value : undefined))
  .refine((value) => value === undefined || /^[0-9]+$/.test(value), {
    message: "Trial length must be a whole number of days",
  })
  .transform((value) => (value === undefined ? undefined : Number(value)))
  .refine((value) => value === undefined || (value >= 1 && value <= 365), {
    message: "Trial length must be between 1 and 365 days",
  });

export const createAcademySubscriptionSchema = z.object({
  academyId: z.string().uuid(),
  planId: z.string().trim().uuid("Select a subscription plan"),
  // Absent/undefined -> no trial -> initialSubscriptionStatus() returns
  // "draft" (PLAN.md's Draft row: awaits a later activateAcademy call,
  // Item 26, to move it to Active). Present -> "trial", trial_ends_at =
  // starts_at + this many days.
  trialDays: optionalTrialDays,
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined)),
});

export type CreateAcademySubscriptionInput = z.input<
  typeof createAcademySubscriptionSchema
>;

export interface CreateAcademySubscriptionError {
  code: "validation" | "plan_not_found" | "plan_inactive";
  message: string;
}

export type CreateAcademySubscriptionResult =
  | {
      ok: true;
      subscriptionId: string;
      status: SubscriptionStatus;
      startsAt: Date;
      trialEndsAt: Date | null;
    }
  | { ok: false; error: CreateAcademySubscriptionError };

/**
 * Creates the initial `academy_subscriptions` row for an academy. Pure
 * DB-write helper (no permission check of its own — see module comment
 * above): validates input, re-verifies the plan exists and is active
 * (`subscription_plans.is_active` — "only active plans should be selectable
 * at registration time"), computes the initial status via
 * `initialSubscriptionStatus()` (lib/subscriptions/state-machine.ts, Item
 * 23) rather than duplicating that decision, inserts the row, and writes a
 * same-transaction audit entry.
 */
export async function createAcademySubscription(
  executor: DbClient,
  actor: { userId: string; role?: string },
  input: CreateAcademySubscriptionInput,
): Promise<CreateAcademySubscriptionResult> {
  const parsed = createAcademySubscriptionSchema.safeParse(input);
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

  const [plan] = await executor
    .select({ id: subscriptionPlans.id, isActive: subscriptionPlans.isActive })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, data.planId))
    .limit(1);

  if (!plan) {
    return {
      ok: false,
      error: { code: "plan_not_found", message: "Selected plan does not exist." },
    };
  }
  if (!plan.isActive) {
    return {
      ok: false,
      error: { code: "plan_inactive", message: "Selected plan is not active." },
    };
  }

  const startsAt = new Date();
  const trialEndsAt = data.trialDays
    ? new Date(startsAt.getTime() + data.trialDays * 24 * 60 * 60 * 1000)
    : null;
  const status = initialSubscriptionStatus({ trialEndsAt });

  const [row] = await executor
    .insert(academySubscriptions)
    .values({
      academyId: data.academyId,
      planId: data.planId,
      status,
      startsAt,
      trialEndsAt,
      notes: data.notes,
      createdBy: actor.userId,
    })
    .returning({ id: academySubscriptions.id });

  // Same-transaction audit write (Cross-Cutting Architecture Decisions:
  // "the audit write happens in the same database transaction as the
  // mutation it protects").
  await recordAudit(
    {
      actorUserId: actor.userId,
      actorRole: actor.role,
      academyId: data.academyId,
      action: "createAcademySubscription",
      entityType: "academy_subscription",
      entityId: row.id,
      after: {
        planId: data.planId,
        status,
        startsAt,
        trialEndsAt,
      },
    },
    executor,
  );

  return { ok: true, subscriptionId: row.id, status, startsAt, trialEndsAt };
}
