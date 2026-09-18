import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { enqueueNotification } from "@/lib/notifications/notifications";

export interface CheckSuspiciousLoginMeta {
  ip?: string;
  userAgent?: string;
  actorRole?: string;
}

/**
 * PLAN.md Phase 0 security considerations: "on each successful signIn,
 * compare the new session's IP/user-agent against that user's recent
 * session history; if unseen, write an audit_logs row (action =
 * 'login.suspicious', result = success)." Decision #11: flagged when the
 * IP/user-agent combination hasn't been seen before for that user (no
 * geolocation) — an exact match on both fields together, not either alone.
 *
 * Must be called BEFORE the new session is created — it compares against
 * prior history, and the session being created right now must not count
 * as having "already been seen" for itself. Only detects and logs;
 * PLAN.md defers actual notification delivery to Phase 5.
 *
 * Returns whether the login was flagged, mainly so tests can assert on it
 * without re-querying audit_logs themselves.
 */
export async function checkSuspiciousLogin(
  userId: string,
  meta: CheckSuspiciousLoginMeta,
): Promise<boolean> {
  const { ip, userAgent, actorRole } = meta;

  const [seen] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.userId, userId),
        ip === undefined ? isNull(sessions.ip) : eq(sessions.ip, ip),
        userAgent === undefined
          ? isNull(sessions.userAgent)
          : eq(sessions.userAgent, userAgent),
      ),
    )
    .limit(1);

  if (seen) return false;

  await recordAudit({
    actorUserId: userId,
    actorRole,
    action: "login.suspicious",
    entityType: "user",
    entityId: userId,
    result: "success",
    ip,
    userAgent,
  });

  // Phase 5 Item 58b: MANDATORY template (security.new_device_signin). This
  // function has no transaction of its own (recordAudit above already ran
  // against the default `db`, not a `tx`), so there's nothing to place this
  // "after" beyond simply calling it here. A notification-enqueue failure
  // (e.g. Redis down) must never fail the sign-in flow that called this
  // function — caught and logged, never rethrown. entityId incorporates the
  // current instant (not just userId) so repeated suspicious logins by the
  // same user each get their own notification instead of being deduped
  // against a single static per-user idempotency key. academyId is
  // deliberately null: this is a platform/user-level security event, not
  // scoped to an academy — checkSuspiciousLogin's own parameters have no
  // academy context to resolve one from.
  // Separator is `_`, not `:` — see lib/subscriptions/renew.ts's identical
  // comment: enqueueNotification's BullMQ jobId embeds entityId between two
  // colons, and BullMQ rejects a custom jobId whose colon count implies more
  // than 3 segments.
  try {
    await enqueueNotification({
      eventType: "auth.suspicious_login",
      entityId: `${userId}_${Date.now()}`,
      templateId: "security.new_device_signin",
      academyId: null,
      userId,
    });
  } catch (err) {
    logger.error("notifications.enqueue_failed", {
      eventType: "auth.suspicious_login",
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return true;
}
