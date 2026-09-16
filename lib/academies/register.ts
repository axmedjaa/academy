import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { academies, academyMemberships, branches, subscriptionPlans, users } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { passwordSchema } from "@/lib/auth/password";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";
import {
  createAcademySubscription,
  createAcademySubscriptionSchema,
  type CreateAcademySubscriptionError,
} from "@/lib/subscriptions/create-subscription";
import type { SubscriptionStatus } from "@/lib/subscriptions/state-machine";

// PLAN.md §4/Item 20: "registerAcademy" is listed in UNGRANTABLE_CAPABILITIES
// (lib/auth/permissions.ts) — hasPermission() returns true for this
// capability only when the actor is platform_owner, so this is the sole
// gate needed here (no platform_admin grant can ever satisfy it).
const REGISTER_ACADEMY_CAPABILITY = "registerAcademy";

export interface RegisterAcademyActionError {
  code:
    | "forbidden"
    | "validation"
    | "owner_email_taken"
    | "plan_unavailable"
    | "conflict";
  message: string;
}

const FORBIDDEN: RegisterAcademyActionError = {
  code: "forbidden",
  message: "You don't have permission to register a new academy.",
};

// Blank strings from a <form> submit are normalized to `undefined` rather
// than stored as empty text — PLAN.md/schema.ts treat these expanded
// profile columns as nullable, "profile complete" fields the onboarding
// checklist (a later item) evaluates, so an empty string and "not yet
// provided" must mean the same thing.
function optionalText(maxLength = 500) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));
}

export const registerAcademySchema = z.object({
  // Academy profile (DESIGN.md §8 /platform/academies/new, step 1).
  name: z.string().trim().min(1, "Academy name is required").max(200),
  defaultCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, "Currency must be a 3-letter ISO code, e.g. USD"),
  type: optionalText(100),
  address: optionalText(500),
  phone: optionalText(50),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined))
    .refine((value) => value === undefined || z.string().email().safeParse(value).success, {
      message: "Enter a valid academy email address",
    }),
  website: optionalText(300),
  logoRef: optionalText(500),
  registrationNumber: optionalText(100),
  primaryContactName: optionalText(200),
  primaryContactPhone: optionalText(50),

  // Owner account (DESIGN.md §8, step 2) — the academy_owner user created in
  // the same transaction (Phase 1 §2 "Onboarding, end to end", step 1).
  ownerEmail: z.string().trim().toLowerCase().email("Enter a valid owner email address"),
  ownerPassword: passwordSchema,

  // Default branch (DESIGN.md §8, step 3) — every academy gets exactly one
  // branch at registration time, per the same onboarding step.
  branchName: z.string().trim().min(1, "Default branch name is required").max(200),
  branchCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, "Default branch code is required")
    .max(30),
  branchAddress: optionalText(500),
  branchPhone: optionalText(50),

  // Subscription (DESIGN.md §8 /platform/academies/new, steps "Plan +
  // allowances" / "Subscription dates") — createAcademySubscription (Item
  // 24) needs a plan_id (academy_subscriptions.plan_id is NOT NULL, no
  // default), so registration requires picking one up front rather than
  // deferring plan assignment to a later action. Reuses
  // createAcademySubscriptionSchema's own planId validator (no transform
  // involved, so re-parsing it there too is a no-op). `trialDays` is
  // deliberately left as a loose optional string here (same shape as
  // optionalText's other fields) rather than re-running its numeric
  // transform/refine pipeline a second time — createAcademySubscription
  // parses+validates the real value itself, and a rejection there surfaces
  // through SubscriptionCreationFailure below.
  planId: createAcademySubscriptionSchema.shape.planId,
  trialDays: optionalText(10),
});

export type RegisterAcademyInput = z.input<typeof registerAcademySchema>;

export type RegisterAcademyResult =
  | {
      ok: true;
      academyId: string;
      branchId: string;
      ownerUserId: string;
      subscriptionId: string;
      subscriptionStatus: SubscriptionStatus;
    }
  | { ok: false; error: RegisterAcademyActionError };

/**
 * Thrown from inside the transaction when createAcademySubscription rejects
 * its input — lets the single outer try/catch (which already exists to
 * catch a slug/branch-code race) translate it into a RegisterAcademyResult
 * without a second layer of transaction/rollback handling.
 */
class SubscriptionCreationFailure extends Error {
  constructor(public readonly subError: CreateAcademySubscriptionError) {
    super(subError.message);
  }
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "academy";
}

/**
 * Finds a slug that doesn't collide with an existing academy, appending
 * `-2`, `-3`, ... to the base slug as needed. This is a best-effort check
 * done before the transaction opens; the database's unique constraint on
 * `academies.slug` (Item 19) is still the final guard against a race
 * between two concurrent registrations picking the same name.
 */
async function findAvailableSlug(baseName: string): Promise<string> {
  const base = slugify(baseName);
  let candidate = base;
  let suffix = 2;

  // Bounded loop: this only iterates more than once or twice when many
  // academies already share the exact same name, which is expected to be
  // rare — no reasonable registration should ever exhaust this.
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const [existing] = await db
      .select({ id: academies.id })
      .from(academies)
      .where(eq(academies.slug, candidate))
      .limit(1);
    if (!existing) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }

  // Effectively unreachable; a random suffix keeps this function total.
  return `${base}-${Date.now()}`;
}

/**
 * Registers a brand-new academy: the `academies` row (expanded profile
 * fields), a default `branches` row, the owner's `users` +
 * `academy_memberships` row, and — per Item 24 — its initial
 * `academy_subscriptions` row via `createAcademySubscription`, all in one
 * transaction, exactly matching PLAN.md Phase 1 §2 "Onboarding, end to end"
 * step (1). The created subscription starts in `trial` (when the caller
 * supplies `trialDays`) or `draft` (when it doesn't) — never `active`
 * directly; PLAN.md's state-transition table has no row that produces
 * Active from registration itself, only `activateAcademy` (Item 26, once
 * the onboarding checklist is satisfied) or a no-trial `activateAcademy`
 * call moves a fresh subscription out of Draft. Payment recording/
 * verification, approval, and activation remain separate, later actions
 * (Items 25/21/26) that operate on the academy/subscription this call
 * creates — out of scope here.
 *
 * Pure/framework-agnostic (no "use server", no next/navigation) so it's
 * directly Vitest-testable against the real local Postgres DB, matching
 * lib/platform-staff/staff.ts's split.
 */
export async function registerAcademy(
  actorContext: AuthContext,
  input: RegisterAcademyInput,
): Promise<RegisterAcademyResult> {
  const allowed = await hasPermission(actorContext, REGISTER_ACADEMY_CAPABILITY);
  if (!allowed) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = registerAcademySchema.safeParse(input);
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

  const [existingOwner] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, data.ownerEmail))
    .limit(1);
  if (existingOwner) {
    return {
      ok: false,
      error: {
        code: "owner_email_taken",
        message: "An account with that owner email already exists.",
      },
    };
  }

  // Best-effort pre-check, same pattern as findAvailableSlug's own comment:
  // done before the transaction opens purely so an obviously-bad plan
  // choice (retired since the page loaded, or never existed) fails fast
  // without opening a transaction. createAcademySubscription (inside the
  // transaction below) re-checks this itself — that is the final guard
  // against a race with e.g. setPlanActive(false) between this check and
  // the insert.
  const [plan] = await db
    .select({ id: subscriptionPlans.id, isActive: subscriptionPlans.isActive })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, data.planId))
    .limit(1);
  if (!plan) {
    return {
      ok: false,
      error: { code: "plan_unavailable", message: "Selected plan does not exist." },
    };
  }
  if (!plan.isActive) {
    return {
      ok: false,
      error: { code: "plan_unavailable", message: "Selected plan is not active." },
    };
  }

  const slug = await findAvailableSlug(data.name);
  const ownerPasswordHash = await hashPassword(data.ownerPassword);

  try {
    const result = await db.transaction(async (tx) => {
      const [academy] = await tx
        .insert(academies)
        .values({
          name: data.name,
          slug,
          defaultCurrency: data.defaultCurrency,
          type: data.type,
          address: data.address,
          phone: data.phone,
          email: data.email,
          website: data.website,
          logoRef: data.logoRef,
          registrationNumber: data.registrationNumber,
          primaryContactName: data.primaryContactName,
          primaryContactPhone: data.primaryContactPhone,
          createdBy: actorContext.userId,
        })
        .returning({ id: academies.id });

      const [branch] = await tx
        .insert(branches)
        .values({
          academyId: academy.id,
          name: data.branchName,
          code: data.branchCode,
          address: data.branchAddress,
          phone: data.branchPhone,
        })
        .returning({ id: branches.id });

      const [owner] = await tx
        .insert(users)
        .values({ email: data.ownerEmail, passwordHash: ownerPasswordHash })
        .returning({ id: users.id });

      await tx.insert(academyMemberships).values({
        userId: owner.id,
        academyId: academy.id,
        role: "academy_owner",
        status: "active",
      });

      // Same-transaction audit write (Cross-Cutting Architecture Decisions:
      // "a sensitive mutation cannot succeed if its audit write fails").
      // Never includes the owner's password/hash — before/after are
      // redacted by recordAudit() regardless, but this also just never
      // passes it in.
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: actorContext.platformRole,
          academyId: academy.id,
          action: "registerAcademy",
          entityType: "academy",
          entityId: academy.id,
          after: {
            name: data.name,
            slug,
            defaultCurrency: data.defaultCurrency,
            type: data.type,
            ownerEmail: data.ownerEmail,
            branchName: data.branchName,
            branchCode: data.branchCode,
          },
        },
        tx,
      );

      // Item 24: "createAcademySubscription wired into registration" — the
      // academy's initial academy_subscriptions row, created in the same
      // transaction so an academy can never exist without one.
      // createAcademySubscription does its own permission-free plan
      // existence/is_active re-check (the pre-check above already covers
      // the common case); a rejection here throws to trigger a full
      // rollback of the academy/branch/owner rows just inserted, caught
      // below and translated back into a RegisterAcademyResult.
      const subscriptionResult = await createAcademySubscription(
        tx,
        { userId: actorContext.userId, role: actorContext.platformRole },
        {
          academyId: academy.id,
          planId: data.planId,
          trialDays: data.trialDays,
        },
      );
      if (!subscriptionResult.ok) {
        throw new SubscriptionCreationFailure(subscriptionResult.error);
      }

      return {
        academyId: academy.id,
        branchId: branch.id,
        ownerUserId: owner.id,
        subscriptionId: subscriptionResult.subscriptionId,
        subscriptionStatus: subscriptionResult.status,
      };
    });

    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof SubscriptionCreationFailure) {
      return {
        ok: false,
        error: {
          // "validation" (e.g. a malformed trialDays) maps straight
          // through; plan_not_found/plan_inactive both surface as the
          // single plan_unavailable code — the UI only needs to know "the
          // chosen plan can't be used," not which of the two it was.
          code: err.subError.code === "validation" ? "validation" : "plan_unavailable",
          message: err.subError.message,
        },
      };
    }
    // Final guard against a race on academies.slug (or, in principle,
    // branches' (academy_id, code) unique index) between the pre-check
    // above and this transaction's insert — see findAvailableSlug's
    // comment. Postgres unique_violation is error code 23505.
    if (typeof err === "object" && err !== null && "code" in err && err.code === "23505") {
      return {
        ok: false,
        error: {
          code: "conflict",
          message: "That academy could not be registered due to a conflicting record. Please try again.",
        },
      };
    }
    throw err;
  }
}
