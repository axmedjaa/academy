import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { recordAudit } from "@/lib/audit";

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

  return true;
}
