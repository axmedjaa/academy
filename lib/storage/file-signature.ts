/**
 * Security audit follow-up (file-upload hardening) — real file-signature
 * ("magic bytes") verification, server-only (uses `Buffer`, so this
 * module must never be imported from a `"use client"` component — see
 * lib/storage/upload-policy.ts for the client-safe constants instead).
 *
 * Why this exists: a presigned R2 PUT binds the `Content-Type` HEADER
 * the client declared when requesting the upload URL (see
 * lib/storage/client.ts's own doc comment on `getUploadUrl`) — but
 * nothing about that prevents a caller from declaring `Content-Type:
 * image/png` while actually uploading a completely different file's
 * bytes underneath that header. `headObject`'s own post-upload check
 * (every one of this app's four upload flows already does this) only
 * re-reads that same self-reported header back from R2 — it was never a
 * check against the real file content. Reading the first few real bytes
 * of the uploaded object and matching them against each format's known
 * magic-byte signature is what actually answers "is this really a
 * JPEG/PNG/WebP/AVIF," independent of anything the uploader claimed.
 *
 * Deliberately NOT a full decode (no `sharp`/image-library parse of the
 * entire file) — this project's existing residual-risk convention (see
 * lib/storage/client.ts's own "no pretend enforcement" framing) is to be
 * explicit about what a check does and doesn't prove rather than build a
 * much larger decode/transcode pipeline for this pass; see this app's
 * upload report for the documented residual risk that follows from that
 * choice (a file could still be a valid-signature "polyglot" crafted to
 * also be interpreted as something else by a different, non-image
 * consumer, which a signature match alone cannot rule out).
 */

export type FileSignatureCheck = (bytes: Buffer) => boolean;

function matchesPrefix(bytes: Buffer, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function matchesAsciiAt(bytes: Buffer, offset: number, ascii: string): boolean {
  if (bytes.length < offset + ascii.length) return false;
  return bytes.subarray(offset, offset + ascii.length).toString("ascii") === ascii;
}

/**
 * One check per `RasterImageContentType` (lib/storage/upload-policy.ts) —
 * kept in lockstep with that union by the exhaustive `Record` type below,
 * so adding a content type there without adding its signature here is a
 * compile error, not a silently-unverified new format.
 */
export const RASTER_IMAGE_SIGNATURES: Record<
  "image/jpeg" | "image/png" | "image/webp" | "image/avif",
  FileSignatureCheck
> = {
  // FF D8 FF — every JPEG variant (JFIF, Exif, etc.) starts with this.
  "image/jpeg": (bytes) => matchesPrefix(bytes, [0xff, 0xd8, 0xff]),
  // 89 50 4E 47 0D 0A 1A 0A — the fixed 8-byte PNG signature (never varies).
  "image/png": (bytes) => matchesPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  // RIFF <4-byte size> WEBP — a RIFF container whose form type is "WEBP".
  "image/webp": (bytes) => matchesAsciiAt(bytes, 0, "RIFF") && matchesAsciiAt(bytes, 8, "WEBP"),
  // ISOBMFF box: <4-byte size> "ftyp" <brand>, brand "avif" for a single
  // AVIF image (the only AVIF this app's upload fields accept — none of
  // them wants an avis/animated-sequence brand, matching this policy's
  // own "no field here benefits from animation" stance).
  "image/avif": (bytes) => matchesAsciiAt(bytes, 4, "ftyp") && matchesAsciiAt(bytes, 8, "avif"),
};

/** How many leading bytes `verifyUploadedObject` needs to fetch for any
 * signature check above to have enough data — AVIF's is the deepest
 * (byte 11), rounded up generously so a slightly larger brand string or
 * a future format never silently runs short. */
export const SIGNATURE_PROBE_BYTES = 32;

/**
 * Matches `bytes` (the object's own leading bytes, fetched via
 * `getObjectPrefix`) against `contentType`'s known signature. Returns
 * `false` — never throws — for a content type this module has no
 * signature for, so an unrecognized/future content type fails closed
 * rather than passing by default.
 */
export function matchesFileSignature(contentType: string, bytes: Buffer): boolean {
  const check = (RASTER_IMAGE_SIGNATURES as Record<string, FileSignatureCheck | undefined>)[contentType];
  return check ? check(bytes) : false;
}
