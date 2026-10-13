import { getObjectPrefix, headObject } from "@/lib/storage/client";
import { SIGNATURE_PROBE_BYTES, matchesFileSignature } from "@/lib/storage/file-signature";
import type { RasterImagePolicy } from "@/lib/storage/upload-policy";

/**
 * Security audit follow-up (file-upload hardening) — the one shared
 * post-upload verification every raster-image field (academy logo, book
 * cover, student photo, course image) now calls, replacing four
 * near-identical hand-copies of "headObject, check content-type is
 * allowlisted, check size is within the limit." What's new on top of
 * that existing check:
 *
 * - rejects an empty (0-byte) object outright, rather than only an
 *   over-large one;
 * - verifies the object's real leading bytes against its declared
 *   content-type's known magic-byte signature (lib/storage/
 *   file-signature.ts) — the part a declared `Content-Type` header
 *   alone can never prove, since nothing stops a caller from uploading
 *   one file's bytes under a different format's declared header.
 *
 * Every failure path's caller is expected to delete the invalid object
 * from R2 immediately (unchanged from the existing convention — this
 * function only decides pass/fail, it never deletes anything itself, so
 * each of the four call sites keeps its own existing `deleteObject` call
 * and its own existing "never write the ref to the database on failure"
 * behavior exactly as before).
 */
export type VerifyUploadError =
  | { code: "not_found"; message: string }
  | { code: "invalid_format"; message: string }
  | { code: "empty"; message: string }
  | { code: "too_large"; message: string }
  | { code: "verification_failed"; message: string };

export type VerifyUploadResult = { ok: true } | { ok: false; error: VerifyUploadError };

const NOT_FOUND: VerifyUploadError = {
  code: "not_found",
  message: "The uploaded file could not be found. Please try uploading again.",
};

const VERIFICATION_FAILED: VerifyUploadError = {
  code: "verification_failed",
  message: "The logo upload could not be verified.",
};

export async function verifyUploadedObject(key: string, policy: RasterImagePolicy): Promise<VerifyUploadResult> {
  const head = await headObject(key);
  if (!head.ok) {
    return { ok: false, error: VERIFICATION_FAILED };
  }
  if (!head.exists) {
    return { ok: false, error: NOT_FOUND };
  }

  const contentType = head.info.contentType;
  if (!contentType || !(policy.contentTypes as readonly string[]).includes(contentType)) {
    return {
      ok: false,
      error: { code: "invalid_format", message: "That file format isn't supported." },
    };
  }

  const size = head.info.contentLength;
  if (size === null || size === 0) {
    return { ok: false, error: { code: "empty", message: "That file is empty." } };
  }
  if (size > policy.maxSizeBytes) {
    return {
      ok: false,
      error: { code: "too_large", message: `File must be ${Math.floor(policy.maxSizeBytes / (1024 * 1024))} MB or smaller.` },
    };
  }

  const prefix = await getObjectPrefix(key, SIGNATURE_PROBE_BYTES);
  if (!prefix.ok) {
    return { ok: false, error: VERIFICATION_FAILED };
  }
  if (!prefix.exists) {
    return { ok: false, error: NOT_FOUND };
  }
  if (!matchesFileSignature(contentType, prefix.bytes)) {
    return {
      ok: false,
      error: { code: "invalid_format", message: "That file doesn't match the format it claims to be." },
    };
  }

  return { ok: true };
}
