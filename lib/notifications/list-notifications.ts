import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { academyMemberships, notificationReads, notifications } from "@/lib/db/schema";
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
 * ---------------------------------------------------------------------
 * Per-user read-tracking for shared (null user_id) rows
 * ---------------------------------------------------------------------
 * Such a row is a SINGLE shared row, not one per recipient, so
 * `notifications.read_at` can't mean "read" for it without hiding it for
 * every other member who can also see it — this is why
 * `markNotificationRead`/`markNotificationsRead` never touch that column
 * for a null-`user_id` row. Instead, this file's own `notificationReads`
 * table (lib/db/schema.ts) gives each (notification, viewer) pair its own
 * read marker: `listNotificationsForUser` LEFT JOINs it (filtered to the
 * caller's own user_id) to compute each shared row's *effective*
 * `readAt` from this caller's point of view, and the mark-read functions
 * upsert into it (instead of updating `notifications.read_at`) for a
 * shared row. An owned (non-null user_id) row is untouched by any of
 * this — it keeps using `notifications.read_at` exactly as before.
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
  /** For an owned row, `notifications.read_at` itself. For a shared
   * (null-`user_id`) row, this caller's own `notificationReads` marker
   * instead (null if they haven't read it) — see this file's module
   * comment. Either way, this is "has *this caller* read it", which is
   * all the UI (and `unreadOnly`) ever needs. */
  readAt: Date | null;
  createdAt: Date;
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
    conditions.push(
      or(
        and(eq(notifications.userId, actorContext.userId), isNull(notifications.readAt)),
        // `notificationReads` is LEFT JOINed below, already filtered to
        // this caller's own user_id in its ON clause — a non-matching
        // shared row therefore reads as NULL here, which is exactly "this
        // caller hasn't read it yet" (an anti-join expressed via WHERE).
        and(isNull(notifications.userId), isNull(notificationReads.readAt)),
      ),
    );
  }

  const rows = await db
    .select({ notification: notifications, sharedReadAt: notificationReads.readAt })
    .from(notifications)
    .leftJoin(
      notificationReads,
      and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.userId, actorContext.userId)),
    )
    .where(and(...conditions))
    .orderBy(desc(notifications.createdAt));

  return rows.map(({ notification, sharedReadAt }) => ({
    id: notification.id,
    academyId: notification.academyId,
    eventType: notification.eventType,
    templateId: notification.templateId,
    status: notification.status,
    readAt: notification.userId === actorContext.userId ? notification.readAt : sharedReadAt,
    createdAt: notification.createdAt,
  }));
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
 * Marks exactly one notification read for the caller. For an owned row,
 * sets `notifications.read_at` via `COALESCE(read_at, now())` — same as
 * before — so a second call on an already-read row is a true no-op (the
 * original read timestamp is preserved) rather than silently advancing it.
 * For a shared (null-`user_id`) row the caller can see (academy-scoped to
 * one of their active memberships), upserts this caller's own marker into
 * `notificationReads` instead — see this file's module comment.
 */
export async function markNotificationRead(
  actorContext: AuthContext,
  notificationId: string,
): Promise<MarkNotificationReadResult> {
  const parsedId = z.string().uuid().safeParse(notificationId);
  if (!parsedId.success) {
    return { ok: false, error: NOTIFICATION_NOT_FOUND };
  }

  const [ownedRow] = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(and(eq(notifications.id, parsedId.data), eq(notifications.userId, actorContext.userId)))
    .returning({ id: notifications.id });

  if (ownedRow) {
    return { ok: true };
  }

  const memberAcademyIds = db
    .select({ academyId: academyMemberships.academyId })
    .from(academyMemberships)
    .where(and(eq(academyMemberships.userId, actorContext.userId), eq(academyMemberships.status, "active")));

  const [sharedRow] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.id, parsedId.data),
        isNull(notifications.userId),
        inArray(notifications.academyId, memberAcademyIds),
      ),
    );

  if (!sharedRow) {
    return { ok: false, error: NOTIFICATION_NOT_FOUND };
  }

  await db
    .insert(notificationReads)
    .values({ notificationId: parsedId.data, userId: actorContext.userId })
    .onConflictDoNothing({ target: [notificationReads.notificationId, notificationReads.userId] });

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
 * Bulk variant of `markNotificationRead`. Ownership/visibility-checked the
 * same way, generalized to a set: an id that's neither owned by the caller
 * nor a shared row they can see (or doesn't exist at all) simply isn't
 * touched — never surfaced as a distinct error, since a bulk call mixing
 * the caller's own ids with a guessed/foreign id must not let the caller
 * learn anything about the foreign id's existence (same IDOR posture as
 * the single-id variant). `markedCount` counts both owned rows updated and
 * shared rows newly/already marked via `notificationReads`.
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

  const ownedRows = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
    .where(and(inArray(notifications.id, parsed.data), eq(notifications.userId, actorContext.userId)))
    .returning({ id: notifications.id });

  const memberAcademyIds = db
    .select({ academyId: academyMemberships.academyId })
    .from(academyMemberships)
    .where(and(eq(academyMemberships.userId, actorContext.userId), eq(academyMemberships.status, "active")));

  const sharedRows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        inArray(notifications.id, parsed.data),
        isNull(notifications.userId),
        inArray(notifications.academyId, memberAcademyIds),
      ),
    );

  if (sharedRows.length > 0) {
    await db
      .insert(notificationReads)
      .values(sharedRows.map((row) => ({ notificationId: row.id, userId: actorContext.userId })))
      .onConflictDoNothing({ target: [notificationReads.notificationId, notificationReads.userId] });
  }

  return { ok: true, markedCount: ownedRows.length + sharedRows.length };
}
