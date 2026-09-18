import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { academyMemberships, notifications } from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * PLAN.md Phase 5, Item 59 — `/academy/notifications`'s own read/write
 * surface, per DESIGN.md §9.8: "list pattern (A) with read/unread filter,
 * mark-as-read (single/bulk)". Lives in its own file rather than being
 * added to lib/notifications/notifications.ts, per this item's own brief
 * ("do not modify enqueueNotification's existing behavior/signature... a
 * new file is fine") and this codebase's pure-logic-plus-thin-action-
 * wrapper convention (lib/academies/certificates.ts + certificates-actions.ts).
 *
 * ---------------------------------------------------------------------
 * Why this is a plain per-user query, not an academy-access-gated one
 * ---------------------------------------------------------------------
 * Every other `/academy/*` read in this codebase resolves "which academy"
 * via `checkAcademyAccessForContext` and scopes the query to that academyId.
 * This one deliberately does not: `notifications.user_id` is the recipient
 * column `enqueueNotification` already stamps at enqueue time (never a
 * client-supplied value), so filtering on
 * `notifications.user_id = actorContext.userId` is already a complete,
 * IDOR-safe "this user's own inbox" scope — there is no id a caller could
 * guess or supply that would surface a row belonging to someone else,
 * regardless of which academy enqueued it (including platform-level rows
 * with a null `academy_id`, which this user's own inbox should still show
 * if they were ever the named recipient). Re-deriving "the caller's
 * academy" on top of that would add nothing (a user's own notifications
 * were, by construction, only ever created for academies/events that
 * concern them) and would incorrectly hide a user's history the moment
 * they left an academy (PLAN.md never says past notifications should
 * disappear on membership change) or a genuinely platform-level row. This
 * is a documented judgment call, not a PLAN.md-mandated shape.
 *
 * ---------------------------------------------------------------------
 * Post-hoc fix — academy-scoped rows with a null user_id are also included
 * ---------------------------------------------------------------------
 * That reasoning assumed every notification names a specific recipient.
 * It doesn't: `lib/academies/approval-requests.ts`'s `createApprovalRequest`
 * (wired in this same wave, Item 58b) deliberately enqueues its
 * `*.approval_requested` notifications with `userId: null` and only
 * `academyId` set — a documented choice to avoid that generic module having
 * to resolve per-entity-type approver permissions itself. Left as a bare
 * `user_id = actorContext.userId` filter, EVERY approval-requested
 * notification (covering results, grade configs, expenses, and student
 * payments) would be created but never surfaced to anyone — a real defect,
 * not a design choice. Fixed by also matching rows where `user_id IS NULL`
 * AND `academy_id` is one the caller currently holds an active membership
 * in — i.e. "addressed to me personally" OR "addressed to any current
 * member of an academy I belong to."
 *
 * Known follow-up, not solved here: such a row is a SINGLE shared row, not
 * one per recipient, so `read_at` is shared state across every member who
 * can see it — `markNotificationRead`/`markNotificationsRead` deliberately
 * do NOT allow marking a null-`user_id` row read (their `WHERE user_id =
 * actorContext.userId` ownership check excludes them), so these rows always
 * render as unread rather than one viewer's "read" silently hiding it for
 * everyone else. Real per-user read-tracking for a shared academy-scoped
 * notification needs its own per-recipient row or a join table — flagged as
 * a later-wave gap, not addressed in this fix.
 *
 * Only `channel = "in_app"` rows are ever returned — per this item's own
 * brief, email/sms rows on this same table are delivery-attempt records,
 * not inbox items (DESIGN.md's inbox concept is exclusively the in-app
 * notification), so those channels are outside `/academy/notifications`
 * regardless of the DELIVERY-STATUS view PLAN.md's Phase 5 §3 mentions for
 * this same route (that delivery-status view, if ever built, is a
 * different, not-yet-scoped read over the other two channels — out of
 * scope for this item, which only builds the in-app inbox DESIGN.md §9.8
 * actually specifies: "list pattern... read/unread filter, mark-as-read").
 */

export interface NotificationListItem {
  id: string;
  academyId: string | null;
  eventType: string;
  templateId: string;
  status: "pending" | "sent" | "failed";
  readAt: Date | null;
  createdAt: Date;
}

function toListItem(row: typeof notifications.$inferSelect): NotificationListItem {
  return {
    id: row.id,
    academyId: row.academyId,
    eventType: row.eventType,
    templateId: row.templateId,
    status: row.status,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

export interface ListNotificationsFilters {
  unreadOnly?: boolean;
}

/**
 * The caller's own in_app inbox, newest first. See this file's module
 * comment for why this never fails/branches on academy access — a resolved
 * `AuthContext` (every call site already requires one; see
 * app/academy/notifications/page.tsx's own `redirect("/login")` guard for a
 * null context) is sufficient on its own.
 */
export async function listNotificationsForUser(
  actorContext: AuthContext,
  filters: ListNotificationsFilters = {},
): Promise<NotificationListItem[]> {
  const memberAcademyIds = db
    .select({ academyId: academyMemberships.academyId })
    .from(academyMemberships)
    .where(and(eq(academyMemberships.userId, actorContext.userId), eq(academyMemberships.status, "active")));

  const conditions = [
    eq(notifications.channel, "in_app"),
    or(
      eq(notifications.userId, actorContext.userId),
      and(isNull(notifications.userId), inArray(notifications.academyId, memberAcademyIds)),
    ),
  ];
  if (filters.unreadOnly) {
    conditions.push(isNull(notifications.readAt));
  }

  const rows = await db
    .select()
    .from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt));

  return rows.map(toListItem);
}

export interface NotificationActionError {
  code: "not_found" | "validation";
  message: string;
}

// Deliberately identical whether `notificationId` is malformed, genuinely
// nonexistent, or belongs to another user — same IDOR-safe generic-response
// convention as every other single-record lookup in this codebase (e.g.
// lib/academies/certificates.ts's `CERTIFICATE_NOT_FOUND`).
const NOTIFICATION_NOT_FOUND: NotificationActionError = {
  code: "not_found",
  message: "Notification not found.",
};

export type MarkNotificationReadResult = { ok: true } | { ok: false; error: NotificationActionError };

/**
 * Sets `read_at` for exactly one notification the caller owns. Uses
 * `COALESCE(read_at, now())` rather than an unconditional overwrite so a
 * second mark-as-read call on an already-read row is a true no-op (the
 * original read timestamp is preserved) rather than silently advancing it
 * — DESIGN.md doesn't discuss re-marking an already-read row, but keeping
 * the first read time is the least-surprising behavior for a "mark as
 * read" action.
 */
export async function markNotificationRead(
  actorContext: AuthContext,
  notificationId: string,
): Promise<MarkNotificationReadResult> {
  const parsedId = z.string().uuid().safeParse(notificationId);
  if (!parsedId.success) {
    return { ok: false, error: NOTIFICATION_NOT_FOUND };
  }

  const [row] = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(and(eq(notifications.id, parsedId.data), eq(notifications.userId, actorContext.userId)))
    .returning({ id: notifications.id });

  if (!row) {
    return { ok: false, error: NOTIFICATION_NOT_FOUND };
  }
  return { ok: true };
}

const MAX_BULK_MARK_READ_IDS = 500;

const notificationIdsInputSchema = z
  .array(z.string().uuid())
  .min(1, "Provide at least one notification id.")
  .max(MAX_BULK_MARK_READ_IDS, `A single bulk mark-as-read call supports at most ${MAX_BULK_MARK_READ_IDS} ids.`);

export type MarkNotificationsReadResult =
  | { ok: true; markedCount: number }
  | { ok: false; error: NotificationActionError };

/**
 * Bulk variant of `markNotificationRead`. Ownership-checked the same way:
 * the `WHERE ... AND user_id = actorContext.userId` clause means an id that
 * doesn't belong to the caller (or doesn't exist at all) simply isn't
 * touched — it is never surfaced as a distinct error, since a bulk call
 * mixing the caller's own ids with a guessed/foreign id must not let the
 * caller learn anything about the foreign id's existence (same IDOR
 * posture as the single-id variant, generalized to a set). `markedCount`
 * only ever counts rows that genuinely belonged to the caller.
 */
export async function markNotificationsRead(
  actorContext: AuthContext,
  notificationIds: string[],
): Promise<MarkNotificationsReadResult> {
  const parsed = notificationIdsInputSchema.safeParse(notificationIds);
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." },
    };
  }

  const rows = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(and(inArray(notifications.id, parsed.data), eq(notifications.userId, actorContext.userId)))
    .returning({ id: notifications.id });

  return { ok: true, markedCount: rows.length };
}
