/**
 * Shared test-only fixtures — real magic-byte prefixes for each
 * `RasterImageContentType` (see lib/storage/file-signature.ts), reused by
 * every upload-field test file (academy-logo, students, books, courses,
 * plus file-signature.test.ts / verify-upload.test.ts) so a "successful
 * upload" test can mock `getObjectPrefix` with bytes that actually pass
 * `matchesFileSignature`, instead of each file hand-rolling its own.
 *
 * Not a `*.test.ts` file, so Vitest's `include: ["**\/*.test.ts"]` never
 * picks this up as a suite of its own.
 */

function padded(bytes: number[], length = 32): Buffer {
  const buffer = Buffer.alloc(length);
  Buffer.from(bytes).copy(buffer);
  return buffer;
}

export const VALID_SIGNATURE_BYTES: Record<"image/jpeg" | "image/png" | "image/webp" | "image/avif", Buffer> = {
  "image/jpeg": padded([0xff, 0xd8, 0xff, 0xe0]),
  "image/png": padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/webp": padded([
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    0x00, 0x00, 0x00, 0x00, // size (irrelevant to the check)
    0x57, 0x45, 0x42, 0x50, // "WEBP"
  ]),
  "image/avif": padded([
    0x00, 0x00, 0x00, 0x1c, // box size (irrelevant to the check)
    0x66, 0x74, 0x79, 0x70, // "ftyp"
    0x61, 0x76, 0x69, 0x66, // "avif"
  ]),
};

/** Deliberately mismatched bytes (a plain text file) — never matches any
 * known signature, for "the declared Content-Type doesn't match the real
 * content" (spoofed-MIME) regression tests. */
export const INVALID_SIGNATURE_BYTES = padded([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-", harmless ASCII either way
