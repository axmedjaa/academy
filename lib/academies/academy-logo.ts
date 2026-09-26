import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { academies } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { ACADEMY_SETTINGS_ACTION, hasAcademyPermission } from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { deleteObject, getDownloadUrl, getUploadUrl, headObject, type StorageContentType } from "@/lib/storage/client";
import { getAcademyLogoKey, isAcademyLogoKey } from "@/lib/storage/keys";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Real academy-logo upload/replace/remove backed by Cloudflare R2 — see
 * lib/storage/client.ts's own module comment for the storage layer this
 * builds on. Gated identically to lib/academies/settings.ts's
 * `updateAcademySettings` (same `academy.settings` permission row: Owner/
 * Admin "full", Manager "view_edit", every other role refused) — logo
 * management is part of the same academy-profile capability, not a new
 * permission of its own.
 *
 * `academies.logoRef` now stores an R2 OBJECT KEY (e.g.
 * "academies/<id>/logos/<uuid>.png"), never a URL — signed URLs expire, so
 * the database must never contain one. lib/academies/settings.ts's general
 * `updateAcademySettings` no longer touches this column at all (see that
 * file's own comment) — it is exclusively managed by the three actions
 * below.
 */

export const MAX_LOGO_SIZE_BYTES = 5 * 1024 * 1024;

const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type AllowedLogoContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

// SVG is deliberately excluded — it can carry active/scriptable content,
// a different security posture than a raster image; not supported in this
// first implementation (see this task's own brief).
const EXTENSION_BY_CONTENT_TYPE: Record<AllowedLogoContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function isAllowedContentType(value: string): value is AllowedLogoContentType {
  return (ALLOWED_CONTENT_TYPES as readonly string[]).includes(value);
}

export interface AcademyLogoActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "upload_failed" | "verification_failed";
  message: string;
}

const FORBIDDEN: AcademyLogoActionError = {
  code: "forbidden",
  message: "You don't have permission to update this academy's logo.",
};

const NOT_FOUND: AcademyLogoActionError = {
  code: "not_found",
  message: "Academy not found.",
};

const INVALID_FORMAT: AcademyLogoActionError = {
  code: "validation",
  message: "Logo must be JPEG, PNG, or WebP.",
};

const TOO_LARGE: AcademyLogoActionError = {
  code: "validation",
  message: "Logo must be 5 MB or smaller.",
};

const VERIFICATION_FAILED: AcademyLogoActionError = {
  code: "verification_failed",
  message: "The logo upload could not be verified.",
};

/**
 * Resolves "which academy, with what role" via `checkAcademyAccessForContext`
 * — never a client-supplied `academyId` — then the same `academy.settings`
 * gate `updateAcademySettings` uses. Shared by all three actions below so
 * the authorization story is identical and defined exactly once.
 */
async function resolveAuthorizedAcademy(
  actorContext: AuthContext,
): Promise<{ ok: true; academyId: string; membershipRole: string } | { ok: false; error: AcademyLogoActionError }> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }
  if (!hasAcademyPermission(access.membershipRole, ACADEMY_SETTINGS_ACTION)) {
    return { ok: false, error: FORBIDDEN };
  }
  return { ok: true, academyId: access.academyId, membershipRole: access.membershipRole };
}

export interface RequestAcademyLogoUploadUrlInput {
  contentType: string;
  fileSizeBytes: number;
}

export type RequestAcademyLogoUploadUrlResult =
  | { ok: true; uploadUrl: string; key: string; expiresInSeconds: number }
  | { ok: false; error: AcademyLogoActionError };

/**
 * Step 1 of the upload flow. Never writes to the database — see
 * `confirmAcademyLogoUpload` for that. The object key is entirely
 * server-generated (lib/storage/keys.ts's `getAcademyLogoKey`, namespaced
 * under the server-resolved `academyId`) — the browser never supplies or
 * chooses it. `fileSizeBytes` is the client's OWN claim, validated here as
 * a first line of defense only; a presigned PUT URL cannot reliably bind a
 * Content-Length ceiling (see lib/storage/client.ts's `getUploadUrl` doc
 * comment) — the real authority is `confirmAcademyLogoUpload`'s
 * `headObject` check on the actual uploaded bytes.
 */
export async function requestAcademyLogoUploadUrl(
  actorContext: AuthContext,
  input: RequestAcademyLogoUploadUrlInput,
): Promise<RequestAcademyLogoUploadUrlResult> {
  const resolved = await resolveAuthorizedAcademy(actorContext);
  if (!resolved.ok) return resolved;

  if (!isAllowedContentType(input.contentType)) {
    return { ok: false, error: INVALID_FORMAT };
  }
  if (!Number.isFinite(input.fileSizeBytes) || input.fileSizeBytes <= 0 || input.fileSizeBytes > MAX_LOGO_SIZE_BYTES) {
    return { ok: false, error: TOO_LARGE };
  }

  const key = getAcademyLogoKey({
    academyId: resolved.academyId,
    extension: EXTENSION_BY_CONTENT_TYPE[input.contentType],
  });

  const result = await getUploadUrl({ key, contentType: input.contentType });
  if (!result.ok) {
    return { ok: false, error: { code: "upload_failed", message: "The logo upload could not be started. Please try again." } };
  }

  return { ok: true, uploadUrl: result.uploadUrl, key, expiresInSeconds: result.expiresInSeconds };
}

export interface ConfirmAcademyLogoUploadInput {
  key: string;
}

export type ConfirmAcademyLogoUploadResult =
  | { ok: true; logoRef: string }
  | { ok: false; error: AcademyLogoActionError };

/**
 * Step 2 — the only path that ever writes `academies.logoRef`. Re-derives
 * `academyId` from the session (never trusts anything about the caller's
 * claimed academy) and requires `key` to match EXACTLY this academy's own
 * logo-key shape (`isAcademyLogoKey`) — a key for a different academy, or
 * anything not shaped like one this module itself generates, is refused
 * before ever touching R2.
 *
 * Then `headObject` is the real verification authority: the object must
 * exist, its actual (server-reported) content-type must be allowed, and
 * its actual size must be within the limit — never the client's claims
 * from step 1. An object that fails this check is deleted from R2
 * immediately (never left as an orphaned invalid upload) and the database
 * is never touched.
 *
 * Replacement ordering (task's own invariant: never lose the only valid
 * reference to a successfully uploaded logo): the new key is committed to
 * the database FIRST, inside the same transaction as the audit row: only
 * once that succeeds is the OLD object deleted from R2, best-effort,
 * outside the transaction (Postgres and R2 can't share one atomic
 * transaction). If that cleanup delete fails, the new logo is already
 * authoritative in the database — the failure is logged as a safe
 * operational error, never rolled back, never surfaced to the user as a
 * problem with their (successful) upload.
 */
export async function confirmAcademyLogoUpload(
  actorContext: AuthContext,
  input: ConfirmAcademyLogoUploadInput,
): Promise<ConfirmAcademyLogoUploadResult> {
  const resolved = await resolveAuthorizedAcademy(actorContext);
  if (!resolved.ok) return resolved;

  if (!isAcademyLogoKey(input.key, resolved.academyId)) {
    return { ok: false, error: { code: "validation", message: "Invalid upload reference." } };
  }

  const head = await headObject(input.key);
  if (!head.ok) {
    return { ok: false, error: VERIFICATION_FAILED };
  }
  if (!head.exists) {
    return { ok: false, error: { code: "not_found", message: "The uploaded file could not be found. Please try uploading again." } };
  }
  if (!head.info.contentType || !isAllowedContentType(head.info.contentType)) {
    await deleteObject(input.key);
    return { ok: false, error: INVALID_FORMAT };
  }
  if (!head.info.contentLength || head.info.contentLength > MAX_LOGO_SIZE_BYTES) {
    await deleteObject(input.key);
    return { ok: false, error: TOO_LARGE };
  }

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ logoRef: academies.logoRef })
      .from(academies)
      .where(eq(academies.id, resolved.academyId))
      .limit(1);
    if (!existing) {
      return null;
    }

    const previousKey = existing.logoRef;

    await tx.update(academies).set({ logoRef: input.key }).where(eq(academies.id, resolved.academyId));

    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: resolved.membershipRole,
        academyId: resolved.academyId,
        action: previousKey ? "replaceAcademyLogo" : "uploadAcademyLogo",
        entityType: "academy",
        entityId: resolved.academyId,
        before: { logoRef: previousKey },
        after: { logoRef: input.key },
      },
      tx,
    );

    return { previousKey };
  });

  if (!result) {
    return { ok: false, error: NOT_FOUND };
  }

  if (result.previousKey && result.previousKey !== input.key) {
    const deleted = await deleteObject(result.previousKey);
    if (!deleted.ok) {
      // Never roll back the (already-committed, already-authoritative) new
      // logo over a cleanup failure — this only leaves an orphaned R2
      // object, an operational concern, not a correctness one. Logged here
      // (not just inside deleteObject) so this specific "replacement left
      // an orphan" situation is distinctly observable, per this task's own
      // "make the orphan cleanup situation observable" requirement.
      logger.warn("academy logo replacement: old R2 object could not be deleted (orphaned)", {
        academyId: resolved.academyId,
      });
    }
  }

  return { ok: true, logoRef: input.key };
}

export type RemoveAcademyLogoResult = { ok: true } | { ok: false; error: AcademyLogoActionError };

/**
 * Removal ordering is the reverse of replacement's, and deliberately so:
 * there is no "new" object to protect here, so this deletes the R2 object
 * FIRST, then clears the database reference. If the R2 object is already
 * missing (e.g. a previous partial failure, or this action retried after
 * an earlier attempt), that's treated as success for R2's part — the
 * database still gets cleared and a safe operational warning is logged,
 * never surfaced to the user as an error, per this task's own "still clear
 * the DB reference" instruction. Never accepts a client-supplied key —
 * only ever acts on the academy's own current `logoRef`, resolved from the
 * database itself. A no-op (still `ok: true`) when there is no logo to
 * remove — idempotent, safe to retry.
 */
export async function removeAcademyLogo(actorContext: AuthContext): Promise<RemoveAcademyLogoResult> {
  const resolved = await resolveAuthorizedAcademy(actorContext);
  if (!resolved.ok) return resolved;

  const [existing] = await db
    .select({ logoRef: academies.logoRef })
    .from(academies)
    .where(eq(academies.id, resolved.academyId))
    .limit(1);
  if (!existing) {
    return { ok: false, error: NOT_FOUND };
  }
  if (!existing.logoRef) {
    return { ok: true };
  }

  const previousKey = existing.logoRef;

  const deleted = await deleteObject(previousKey);
  if (!deleted.ok) {
    logger.warn("academy logo removal: R2 object could not be deleted (clearing database reference anyway)", {
      academyId: resolved.academyId,
    });
  }

  await db.transaction(async (tx) => {
    await tx.update(academies).set({ logoRef: null }).where(eq(academies.id, resolved.academyId));
    await recordAudit(
      {
        actorUserId: actorContext.userId,
        actorRole: resolved.membershipRole,
        academyId: resolved.academyId,
        action: "removeAcademyLogo",
        entityType: "academy",
        entityId: resolved.academyId,
        before: { logoRef: previousKey },
        after: { logoRef: null },
      },
      tx,
    );
  });

  return { ok: true };
}

/**
 * A plain formatting helper, NOT a Server Action — never called with a
 * client-supplied key. Only ever called server-side (e.g. from
 * `/academy/settings`'s page.tsx) with a key already read from an
 * authorized DB row (the same `getAcademySettings` read that page already
 * performs), the same "display-field fetch on an already-authorized value"
 * pattern as lib/academies/id-cards-actions.ts's `resolveStudentName`.
 * Returns `null` (never throws) if there's no logo, or if R2 is
 * unreachable/misconfigured — a missing preview image is the correct
 * degraded behavior, not a page-breaking error.
 */
export async function getAcademyLogoUrl(logoRef: string | null): Promise<string | null> {
  if (!logoRef) return null;
  const result = await getDownloadUrl({ key: logoRef });
  return result.ok ? result.downloadUrl : null;
}

export { ALLOWED_CONTENT_TYPES as ALLOWED_LOGO_CONTENT_TYPES };
export type { StorageContentType };
