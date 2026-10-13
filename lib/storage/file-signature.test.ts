import { describe, expect, it } from "vitest";
import { RASTER_IMAGE_SIGNATURES, SIGNATURE_PROBE_BYTES, matchesFileSignature } from "./file-signature";
import { INVALID_SIGNATURE_BYTES, VALID_SIGNATURE_BYTES } from "./test-signature-fixtures";

describe("matchesFileSignature", () => {
  it.each(Object.keys(RASTER_IMAGE_SIGNATURES) as (keyof typeof RASTER_IMAGE_SIGNATURES)[])(
    "matches %s against its own real magic bytes",
    (contentType) => {
      expect(matchesFileSignature(contentType, VALID_SIGNATURE_BYTES[contentType])).toBe(true);
    },
  );

  it.each(Object.keys(RASTER_IMAGE_SIGNATURES) as (keyof typeof RASTER_IMAGE_SIGNATURES)[])(
    "rejects %s against unrelated bytes (spoofed MIME)",
    (contentType) => {
      expect(matchesFileSignature(contentType, INVALID_SIGNATURE_BYTES)).toBe(false);
    },
  );

  it("rejects cross-matches — a PNG's bytes never pass as JPEG/WebP/AVIF", () => {
    expect(matchesFileSignature("image/jpeg", VALID_SIGNATURE_BYTES["image/png"])).toBe(false);
    expect(matchesFileSignature("image/webp", VALID_SIGNATURE_BYTES["image/png"])).toBe(false);
    expect(matchesFileSignature("image/avif", VALID_SIGNATURE_BYTES["image/png"])).toBe(false);
  });

  it("fails closed (false, never throws) for an unrecognized content type", () => {
    expect(matchesFileSignature("application/pdf", VALID_SIGNATURE_BYTES["image/png"])).toBe(false);
    expect(matchesFileSignature("image/svg+xml", VALID_SIGNATURE_BYTES["image/png"])).toBe(false);
  });

  it("fails closed (never throws) when given fewer bytes than the signature needs", () => {
    expect(matchesFileSignature("image/png", Buffer.alloc(0))).toBe(false);
    expect(matchesFileSignature("image/avif", Buffer.from([0x00, 0x00]))).toBe(false);
  });

  it("SIGNATURE_PROBE_BYTES is enough for every known signature to be checkable", () => {
    for (const contentType of Object.keys(RASTER_IMAGE_SIGNATURES) as (keyof typeof RASTER_IMAGE_SIGNATURES)[]) {
      const bytes = VALID_SIGNATURE_BYTES[contentType].subarray(0, SIGNATURE_PROBE_BYTES);
      expect(matchesFileSignature(contentType, bytes)).toBe(true);
    }
  });
});
