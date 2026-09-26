import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factories below (hoisted by Vitest to the top of
// the file) can share the same mock references as the test bodies. No test
// in this file ever calls the real Cloudflare R2 API.
const {
  sendMock,
  getSignedUrlMock,
  s3ClientCtor,
  getS3ClientConstructCount,
  resetS3ClientConstructCount,
  putCtorMock,
  getCtorMock,
  deleteCtorMock,
  headCtorMock,
} = vi.hoisted(() => {
    const sendMock = vi.fn();
    let constructCount = 0;
    // Deliberately a plain class, not `vi.fn(function(){...})` — vitest's
    // mock-function wrapper doesn't reliably preserve constructor
    // semantics for `new`, so this tracks "was S3Client constructed" with
    // its own counter instead of relying on a spy's call list.
    class MockS3Client {
      send = sendMock;
      constructor() {
        constructCount += 1;
      }
    }
    const getSignedUrlMock = vi.fn();
    // Plain `function` expressions, not arrow functions — the real
    // `client.ts` instantiates these via `new`, and arrow functions throw
    // immediately when called with `new`. A regular function that
    // explicitly returns an object works fine as a `new`-able mock (JS
    // uses the returned object in place of `this`).
    const putCtorMock = vi.fn(function PutObjectCommandMock(input: unknown) {
      return { __type: "PutObjectCommand", input };
    });
    const getCtorMock = vi.fn(function GetObjectCommandMock(input: unknown) {
      return { __type: "GetObjectCommand", input };
    });
    const deleteCtorMock = vi.fn(function DeleteObjectCommandMock(input: unknown) {
      return { __type: "DeleteObjectCommand", input };
    });
    const headCtorMock = vi.fn(function HeadObjectCommandMock(input: unknown) {
      return { __type: "HeadObjectCommand", input };
    });
    return {
      sendMock,
      getSignedUrlMock,
      s3ClientCtor: MockS3Client,
      getS3ClientConstructCount: () => constructCount,
      resetS3ClientConstructCount: () => {
        constructCount = 0;
      },
      putCtorMock,
      getCtorMock,
      deleteCtorMock,
      headCtorMock,
    };
  });

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: s3ClientCtor,
  PutObjectCommand: putCtorMock,
  GetObjectCommand: getCtorMock,
  DeleteObjectCommand: deleteCtorMock,
  HeadObjectCommand: headCtorMock,
}));
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: getSignedUrlMock }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

import { logger } from "@/lib/logger";
import { deleteObject, getDownloadUrl, getUploadUrl, headObject } from "./client";

const ORIGINAL_ENV = { ...process.env };
const CONFIGURED_ENV = {
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
  R2_BUCKET_NAME: "test-bucket",
};

beforeEach(() => {
  sendMock.mockReset();
  getSignedUrlMock.mockReset();
  resetS3ClientConstructCount();
  vi.mocked(logger.error).mockClear();
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET_NAME;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function configureEnv(): void {
  Object.assign(process.env, CONFIGURED_ENV);
}

describe("getUploadUrl", () => {
  it("fails clearly and never touches the SDK when R2 is not configured", async () => {
    const result = await getUploadUrl({ key: "academies/x/logos/a.png", contentType: "image/png" });
    expect(result.ok).toBe(false);
    expect(getS3ClientConstructCount()).toBe(0);
    expect(getSignedUrlMock).not.toHaveBeenCalled();
  });

  it("generates a presigned upload URL scoped to the given key and content type", async () => {
    configureEnv();
    getSignedUrlMock.mockResolvedValue("https://r2.example/signed-put-url");

    const result = await getUploadUrl({ key: "academies/abc/logos/1.png", contentType: "image/png" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.uploadUrl).toBe("https://r2.example/signed-put-url");
      expect(result.expiresInSeconds).toBe(5 * 60);
    }

    expect(putCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: "test-bucket", Key: "academies/abc/logos/1.png", ContentType: "image/png" }),
    );
    expect(getSignedUrlMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: 5 * 60 });
  });

  it("returns a safe error (no SDK internals) when presigning throws", async () => {
    configureEnv();
    getSignedUrlMock.mockRejectedValue(new Error("credential error: aws_secret=super-secret-value"));

    const result = await getUploadUrl({ key: "academies/abc/logos/1.png", contentType: "image/png" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain("super-secret-value");
    }
  });
});

describe("getDownloadUrl", () => {
  it("fails clearly when R2 is not configured", async () => {
    const result = await getDownloadUrl({ key: "academies/abc/logos/1.png" });
    expect(result.ok).toBe(false);
  });

  it("generates a presigned GET URL with the 15-minute default expiry", async () => {
    configureEnv();
    getSignedUrlMock.mockResolvedValue("https://r2.example/signed-get-url");

    const result = await getDownloadUrl({ key: "academies/abc/logos/1.png" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.downloadUrl).toBe("https://r2.example/signed-get-url");

    expect(getCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: "test-bucket", Key: "academies/abc/logos/1.png" }),
    );
    expect(getSignedUrlMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), { expiresIn: 15 * 60 });
  });
});

describe("deleteObject", () => {
  it("fails clearly when R2 is not configured", async () => {
    const result = await deleteObject("academies/abc/logos/1.png");
    expect(result.ok).toBe(false);
  });

  it("calls DeleteObjectCommand for the given key", async () => {
    configureEnv();
    sendMock.mockResolvedValue({});

    const result = await deleteObject("academies/abc/logos/1.png");
    expect(result.ok).toBe(true);
    expect(deleteCtorMock).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: "test-bucket", Key: "academies/abc/logos/1.png" }),
    );
    expect(sendMock).toHaveBeenCalled();
  });

  it("returns a safe error when the delete call throws", async () => {
    configureEnv();
    sendMock.mockRejectedValue(new Error("network error"));

    const result = await deleteObject("academies/abc/logos/1.png");
    expect(result.ok).toBe(false);
  });
});

describe("headObject", () => {
  it("reports exists:false for a NotFound error, without surfacing it as a failure", async () => {
    configureEnv();
    const notFound = new Error("not found");
    notFound.name = "NotFound";
    sendMock.mockRejectedValue(notFound);

    const result = await headObject("academies/abc/logos/missing.png");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.exists).toBe(false);
  });

  it("returns real content-type/content-length for an existing object", async () => {
    configureEnv();
    sendMock.mockResolvedValue({ ContentType: "image/png", ContentLength: 12345 });

    const result = await headObject("academies/abc/logos/1.png");
    expect(result.ok).toBe(true);
    if (result.ok && result.exists) {
      expect(result.info.contentType).toBe("image/png");
      expect(result.info.contentLength).toBe(12345);
    }
  });

  it("returns a generic client-facing error for a non-NotFound provider error (server log may carry the provider's own safe message, the client response never does)", async () => {
    configureEnv();
    sendMock.mockRejectedValue(new Error("AccessDenied"));

    const result = await headObject("academies/abc/logos/1.png");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Failed to verify the uploaded file.");
      expect(result.error).not.toContain("AccessDenied");
    }
  });
});

describe("credential safety", () => {
  it("never logs the configured access key or secret key", async () => {
    configureEnv();
    getSignedUrlMock.mockRejectedValue(new Error("boom"));

    await getUploadUrl({ key: "academies/abc/logos/1.png", contentType: "image/png" });

    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logged).not.toContain(CONFIGURED_ENV.R2_ACCESS_KEY_ID);
    expect(logged).not.toContain(CONFIGURED_ENV.R2_SECRET_ACCESS_KEY);
  });
});
