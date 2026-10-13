import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real Cloudflare R2 is never called from the test suite — mocking this
// one boundary module (same convention as every other provider-boundary
// test in this codebase) lets `verifyUploadedObject` be tested as a pure
// decision function over whatever headObject/getObjectPrefix report.
vi.mock("./client", () => ({
  headObject: vi.fn(),
  getObjectPrefix: vi.fn(),
}));

import { getObjectPrefix, headObject } from "./client";
import { verifyUploadedObject } from "./verify-upload";
import { RASTER_IMAGE_POLICY } from "./upload-policy";
import { INVALID_SIGNATURE_BYTES, VALID_SIGNATURE_BYTES } from "./test-signature-fixtures";

const headObjectMock = vi.mocked(headObject);
const getObjectPrefixMock = vi.mocked(getObjectPrefix);

beforeEach(() => {
  headObjectMock.mockReset();
  getObjectPrefixMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("verifyUploadedObject", () => {
  it("passes for a real object whose declared content-type, size, and real bytes all agree", async () => {
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });
    getObjectPrefixMock.mockResolvedValue({ ok: true, exists: true, bytes: VALID_SIGNATURE_BYTES["image/png"] });

    const result = await verifyUploadedObject("academies/x/logos/1.png", RASTER_IMAGE_POLICY);
    expect(result.ok).toBe(true);
    // A passing check must have actually inspected the real bytes, not
    // short-circuited before the signature read.
    expect(getObjectPrefixMock).toHaveBeenCalled();
  });

  it("fails with verification_failed (never throws) when headObject itself fails", async () => {
    headObjectMock.mockResolvedValue({ ok: false, error: "boom" });

    const result = await verifyUploadedObject("academies/x/logos/1.png", RASTER_IMAGE_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("verification_failed");
    expect(getObjectPrefixMock).not.toHaveBeenCalled();
  });

  it("fails with not_found when the object doesn't exist", async () => {
    headObjectMock.mockResolvedValue({ ok: true, exists: false });

    const result = await verifyUploadedObject("academies/x/logos/1.png", RASTER_IMAGE_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
    expect(getObjectPrefixMock).not.toHaveBeenCalled();
  });

  it("fails with invalid_format when the declared content-type isn't in the policy's allowlist, without reading bytes", async () => {
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "application/pdf", contentLength: 1000 } });

    const result = await verifyUploadedObject("academies/x/logos/1.pdf", RASTER_IMAGE_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_format");
    expect(getObjectPrefixMock).not.toHaveBeenCalled();
  });

  it("fails with invalid_format when there is no declared content-type at all", async () => {
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: null, contentLength: 1000 } });

    const result = await verifyUploadedObject("academies/x/logos/1.png", RASTER_IMAGE_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_format");
  });

  it("fails with empty for a 0-byte object, without reading bytes", async () => {
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 0 } });

    const result = await verifyUploadedObject("academies/x/logos/1.png", RASTER_IMAGE_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("empty");
    expect(getObjectPrefixMock).not.toHaveBeenCalled();
  });

  it("fails with empty when contentLength is null", async () => {
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: null } });

    const result = await verifyUploadedObject("academies/x/logos/1.png", RASTER_IMAGE_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("empty");
  });

  it("fails with too_large when the real size exceeds the policy's limit, without reading bytes", async () => {
    headObjectMock.mockResolvedValue({
      ok: true,
      exists: true,
      info: { contentType: "image/png", contentLength: RASTER_IMAGE_POLICY.maxSizeBytes + 1 },
    });

    const result = await verifyUploadedObject("academies/x/logos/1.png", RASTER_IMAGE_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("too_large");
    expect(getObjectPrefixMock).not.toHaveBeenCalled();
  });

  it("fails with invalid_format when the real bytes don't match the declared content-type (spoofed MIME)", async () => {
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });
    getObjectPrefixMock.mockResolvedValue({ ok: true, exists: true, bytes: INVALID_SIGNATURE_BYTES });

    const result = await verifyUploadedObject("academies/x/logos/1.png", RASTER_IMAGE_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_format");
  });

  it("fails with verification_failed when the byte-prefix read itself fails", async () => {
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });
    getObjectPrefixMock.mockResolvedValue({ ok: false, error: "boom" });

    const result = await verifyUploadedObject("academies/x/logos/1.png", RASTER_IMAGE_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("verification_failed");
  });

  it("fails with not_found when the byte-prefix read reports the object no longer exists", async () => {
    headObjectMock.mockResolvedValue({ ok: true, exists: true, info: { contentType: "image/png", contentLength: 1000 } });
    getObjectPrefixMock.mockResolvedValue({ ok: true, exists: false });

    const result = await verifyUploadedObject("academies/x/logos/1.png", RASTER_IMAGE_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_found");
  });

  it("never includes a bucket name, key, or storage credential in any error message", async () => {
    headObjectMock.mockResolvedValue({ ok: false, error: "boom" });
    const result = await verifyUploadedObject("academies/secret-academy-id/logos/1.png", RASTER_IMAGE_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain("secret-academy-id");
      expect(result.error.message).not.toMatch(/https?:\/\//);
    }
  });
});
