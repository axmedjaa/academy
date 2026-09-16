import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { academies, users } from "@/lib/db/schema";
import { hasPermission } from "@/lib/auth/permissions";
import { recordAudit } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * PLAN.md Phase 1, Item 21 (shell scope — see app/platform/academies/*
 * comments for exactly what's deferred to later items): `approveAcademy`
 * sets `academies.approved_by`/`approved_at`. "approveAcademy" is already
 * in UNGRANTABLE_CAPABILITIES (lib/auth/permissions.ts), so hasPermission()
 * returns true here only for platform_owner — no platform_admin grant can
 * ever satisfy it.
 */
const APPROVE_CAPABILITY = "approveAcademy";

export interface ApproveAcademyError {
  code: "forbidden" | "validation" | "not_found" | "already_approved";
  message: string;
}

const FORBIDDEN: ApproveAcademyError = {
  code: "forbidden",
  message: "You don't have permission to approve academies.",
};

const approveAcademyInputSchema = z.object({
  academyId: z.string().uuid("Invalid academy id."),
});

/**
 * Lifecycle state is deliberately derived, never stored (schema.ts's
 * comment on the `academies` table, Decision #1): pending-approval =
 * approved_at IS NULL, approved = approved_at IS NOT NULL, closed =
 * closed_at IS NOT NULL (closed_at overrides — no closeAcademy action
 * exists yet to set it, but the column already does, so this stays
 * defensive rather than assuming it's always null).
 */
export type AcademyLifecycleStatus = "pending_approval" | "approved" | "closed";

export function deriveAcademyStatus(row: {
  approvedAt: Date | null;
  closedAt: Date | null;
}): AcademyLifecycleStatus {
  if (row.closedAt) return "closed";
  if (row.approvedAt) return "approved";
  return "pending_approval";
}

export interface AcademySummary {
  id: string;
  name: string;
  slug: string;
  type: string | null;
  defaultCurrency: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logoRef: string | null;
  registrationNumber: string | null;
  primaryContactName: string | null;
  primaryContactPhone: string | null;
  createdBy: string;
  createdByEmail: string | null;
  approvedBy: string | null;
  approvedByEmail: string | null;
  approvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  status: AcademyLifecycleStatus;
}

type AcademyRow = typeof academies.$inferSelect;

function toSummary(
  row: AcademyRow,
  emails: { createdByEmail: string | null; approvedByEmail: string | null },
): AcademySummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    defaultCurrency: row.defaultCurrency,
    address: row.address,
    phone: row.phone,
    email: row.email,
    website: row.website,
    logoRef: row.logoRef,
    registrationNumber: row.registrationNumber,
    primaryContactName: row.primaryContactName,
    primaryContactPhone: row.primaryContactPhone,
    createdBy: row.createdBy,
    createdByEmail: emails.createdByEmail,
    approvedBy: row.approvedBy,
    approvedByEmail: emails.approvedByEmail,
    approvedAt: row.approvedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    status: deriveAcademyStatus(row),
  };
}

/**
 * Lists every academy for /platform/academies, newest first. Callers must
 * already have checked hasPermission() themselves (matches
 * listPlatformStaff()'s convention in lib/platform-staff/staff.ts — this
 * helper does not re-check).
 */
export async function listAcademies(): Promise<AcademySummary[]> {
  const rows = await db
    .select({
      academy: academies,
      createdByEmail: users.email,
    })
    .from(academies)
    .innerJoin(users, eq(users.id, academies.createdBy))
    .orderBy(desc(academies.createdAt));

  // approvedBy is nullable, so it can't share the innerJoin above — a
  // second lookup keyed by id is simpler than a conditional join clause.
  const approvedByIds = rows
    .map((row) => row.academy.approvedBy)
    .filter((id): id is string => id !== null);

  const approverEmailById = new Map<string, string>();
  if (approvedByIds.length > 0) {
    const approverRows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, approvedByIds));
    for (const approver of approverRows) {
      approverEmailById.set(approver.id, approver.email);
    }
  }

  return rows.map(({ academy, createdByEmail }) =>
    toSummary(academy, {
      createdByEmail,
      approvedByEmail: academy.approvedBy
        ? (approverEmailById.get(academy.approvedBy) ?? null)
        : null,
    }),
  );
}

/**
 * Fetches a single academy for /platform/academies/[id]. Returns null for
 * a missing or malformed id (page renders a calm "not found" state either
 * way) rather than throwing. Callers must already have checked
 * hasPermission() themselves, same convention as listAcademies() above.
 */
export async function getAcademyById(
  academyId: string,
): Promise<AcademySummary | null> {
  const parsed = z.string().uuid().safeParse(academyId);
  if (!parsed.success) return null;

  const [row] = await db
    .select()
    .from(academies)
    .where(eq(academies.id, parsed.data))
    .limit(1);
  if (!row) return null;

  const [creator] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, row.createdBy))
    .limit(1);

  let approvedByEmail: string | null = null;
  if (row.approvedBy) {
    const [approver] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, row.approvedBy))
      .limit(1);
    approvedByEmail = approver?.email ?? null;
  }

  return toSummary(row, {
    createdByEmail: creator?.email ?? null,
    approvedByEmail,
  });
}

export type ApproveAcademyResult =
  | { ok: true; academy: AcademySummary }
  | { ok: false; error: ApproveAcademyError };

/**
 * Sets academies.approved_by/approved_at (PLAN.md Phase 1 §2/§4). Gated so
 * only platform_owner can ever call it — enforced via hasPermission()
 * against the ungrantable "approveAcademy" capability, not a role check
 * here directly, matching every other mutation in this codebase (see
 * requireStaffManagePermission in lib/platform-staff/staff.ts).
 *
 * Deliberately NOT implemented here (PLAN.md Items 22-26, not yet built):
 * any onboarding-checklist precondition (plan selected/payment verified),
 * gating on `getOnboardingChecklistStatus`, or a rejection path (PLAN.md
 * Phase 1 §4 explicitly says rejection reuses `cancelAcademy`, Item 26 —
 * this action only ever sets approved_by/approved_at, never a rejected
 * state, because no such state exists on this schema).
 */
export async function approveAcademy(
  actorContext: AuthContext,
  academyId: string,
): Promise<ApproveAcademyResult> {
  const allowed = await hasPermission(actorContext, APPROVE_CAPABILITY);
  if (!allowed) {
    return { ok: false, error: FORBIDDEN };
  }

  const parsed = approveAcademyInputSchema.safeParse({ academyId });
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        message: parsed.error.issues[0]?.message ?? "Invalid input.",
      },
    };
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: academies.id, approvedAt: academies.approvedAt })
      .from(academies)
      .where(eq(academies.id, parsed.data.academyId))
      .limit(1);

    if (!existing) {
      return {
        ok: false,
        error: { code: "not_found", message: "Academy not found." },
      } as const;
    }
    if (existing.approvedAt) {
      return {
        ok: false,
        error: {
          code: "already_approved",
          message: "This academy has already been approved.",
        },
      } as const;
    }

    // The `approvedAt IS NULL` clause here (not just the select above)
    // closes the race between two concurrent approveAcademy calls — only
    // one of them can ever be the row that flips a non-null approved_at.
    const [updated] = await tx
      .update(academies)
      .set({ approvedBy: actorContext.userId, approvedAt: new Date() })
      .where(
        and(eq(academies.id, parsed.data.academyId), isNull(academies.approvedAt)),
      )
      .returning();

    if (!updated) {
      return {
        ok: false,
        error: {
          code: "already_approved",
          message: "This academy has already been approved.",
        },
      } as const;
    }

    // Same-transaction audit write (Cross-Cutting Architecture Decisions:
    // "a sensitive mutation cannot succeed if its audit write fails").
    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: actorContext.platformRole,
        academyId: updated.id,
        action: "approveAcademy",
        entityType: "academy",
        entityId: updated.id,
        before: { approvedAt: null, approvedBy: null },
        after: { approvedAt: updated.approvedAt, approvedBy: updated.approvedBy },
      },
      tx,
    );

    const [creator] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, updated.createdBy))
      .limit(1);
    const [approver] = await tx
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, actorContext.userId))
      .limit(1);

    return {
      ok: true,
      academy: toSummary(updated, {
        createdByEmail: creator?.email ?? null,
        approvedByEmail: approver?.email ?? null,
      }),
    };
  });
}
