import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { logger } from "@/lib/logger";

/**
 * Isolates the R2/S3 SDK behind this one module — nothing outside
 * lib/storage ever imports `@aws-sdk/*` or touches R2 credentials directly,
 * same architectural principle as lib/email/client.ts isolating Resend
 * behind `sendEmail`. Cloudflare R2 is accessed purely through its
 * S3-compatible API (`https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com`),
 * so this module (and the interface it exposes) stays storage-oriented,
 * not Cloudflare-specific — a future provider swap only touches this file.
 *
 * `CLOUDFLARE_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/
 * `R2_BUCKET_NAME` are deliberately NOT in lib/env.ts's required schema —
 * the app must still boot and serve every unrelated feature when R2 isn't
 * configured yet. Presence is checked here, at call time (same convention
 * as lib/email/client.ts), so a storage-dependent flow fails safely (a
 * returned error, logged with no secrets) instead of the whole app
 * crashing at startup.
 *
 * The bucket is always private. Nothing in this module ever creates or
 * assumes a public URL — every read goes through a short-lived signed GET,
 * every write through a short-lived signed PUT, and callers (Server
 * Actions) never receive R2 credentials, only the signed URL itself.
 */

const UPLOAD_URL_EXPIRES_SECONDS = 5 * 60;
const DOWNLOAD_URL_EXPIRES_SECONDS = 15 * 60;

export type StorageContentType = "image/jpeg" | "image/png" | "image/webp" | "application/pdf";

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

const REQUIRED_ENV_VARS = ["CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"] as const;

function loadConfig(): R2Config | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    return null;
  }
  return { accountId, accessKeyId, secretAccessKey, bucketName };
}

function logNotConfigured(action: string, meta: Record<string, unknown> = {}): void {
  logger.error(`storage ${action}: R2 is not configured`, {
    ...meta,
    missingEnvVars: REQUIRED_ENV_VARS.filter((name) => !process.env[name]),
  });
}

function getClient(config: R2Config): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
}

function safeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface GetUploadUrlInput {
  key: string;
  contentType: StorageContentType;
  expiresInSeconds?: number;
}

export type GetUploadUrlResult =
  | { ok: true; uploadUrl: string; expiresInSeconds: number }
  | { ok: false; error: string };

/**
 * A presigned PUT URL, scoped to exactly one object key and content type.
 *
 * IMPORTANT — what this does and does not enforce: `ContentType` is part
 * of the signed request, so R2 rejects a PUT whose actual `Content-Type`
 * header doesn't match what was authorized here. A plain SigV4-presigned
 * PUT URL (as opposed to a presigned POST policy with conditions) cannot
 * reliably bind a `Content-Length` ceiling with this SDK — there is no
 * "pretend enforcement" here. Callers MUST validate the client's reported
 * size before calling this, and MUST verify the real size with
 * `headObject` after the upload completes, before trusting the object at
 * all (see lib/academies/academy-logo.ts's confirm step).
 */
export async function getUploadUrl(input: GetUploadUrlInput): Promise<GetUploadUrlResult> {
  const config = loadConfig();
  if (!config) {
    logNotConfigured("upload url not generated", { key: input.key });
    return { ok: false, error: "File storage is not configured." };
  }

  const expiresInSeconds = input.expiresInSeconds ?? UPLOAD_URL_EXPIRES_SECONDS;

  try {
    const client = getClient(config);
    const command = new PutObjectCommand({
      Bucket: config.bucketName,
      Key: input.key,
      ContentType: input.contentType,
    });
    const uploadUrl = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    return { ok: true, uploadUrl, expiresInSeconds };
  } catch (err) {
    logger.error("storage upload url generation failed", { key: input.key, error: safeErrorMessage(err) });
    return { ok: false, error: "Failed to prepare the upload. Please try again." };
  }
}

export interface GetDownloadUrlInput {
  key: string;
  expiresInSeconds?: number;
}

export type GetDownloadUrlResult = { ok: true; downloadUrl: string } | { ok: false; error: string };

export async function getDownloadUrl(input: GetDownloadUrlInput): Promise<GetDownloadUrlResult> {
  const config = loadConfig();
  if (!config) {
    logNotConfigured("download url not generated", { key: input.key });
    return { ok: false, error: "File storage is not configured." };
  }

  try {
    const client = getClient(config);
    const command = new GetObjectCommand({ Bucket: config.bucketName, Key: input.key });
    const downloadUrl = await getSignedUrl(client, command, {
      expiresIn: input.expiresInSeconds ?? DOWNLOAD_URL_EXPIRES_SECONDS,
    });
    return { ok: true, downloadUrl };
  } catch (err) {
    logger.error("storage download url generation failed", { key: input.key, error: safeErrorMessage(err) });
    return { ok: false, error: "Failed to generate a download link. Please try again." };
  }
}

export type DeleteObjectResult = { ok: true } | { ok: false; error: string };

export async function deleteObject(key: string): Promise<DeleteObjectResult> {
  const config = loadConfig();
  if (!config) {
    logNotConfigured("object not deleted", { key });
    return { ok: false, error: "File storage is not configured." };
  }

  try {
    const client = getClient(config);
    await client.send(new DeleteObjectCommand({ Bucket: config.bucketName, Key: key }));
    return { ok: true };
  } catch (err) {
    logger.error("storage object deletion failed", { key, error: safeErrorMessage(err) });
    return { ok: false, error: "Failed to delete the file." };
  }
}

export interface HeadObjectInfo {
  contentType: string | null;
  contentLength: number | null;
}

export type HeadObjectResult =
  | { ok: true; exists: true; info: HeadObjectInfo }
  | { ok: true; exists: false }
  | { ok: false; error: string };

/**
 * The real, server-verified source of truth for what actually landed in
 * R2 — never the client's claimed content-type/size. Callers use this
 * after a PUT completes to confirm the object exists and matches
 * expectations before ever writing anything to the database (see
 * `confirmAcademyLogoUpload`).
 */
export async function headObject(key: string): Promise<HeadObjectResult> {
  const config = loadConfig();
  if (!config) {
    logNotConfigured("object not verified", { key });
    return { ok: false, error: "File storage is not configured." };
  }

  try {
    const client = getClient(config);
    const result = await client.send(new HeadObjectCommand({ Bucket: config.bucketName, Key: key }));
    return {
      ok: true,
      exists: true,
      info: {
        contentType: result.ContentType ?? null,
        contentLength: result.ContentLength ?? null,
      },
    };
  } catch (err) {
    // S3-compatible APIs signal "not found" as a thrown error named
    // "NotFound" (a HEAD response has no body to inspect otherwise).
    if (err instanceof Error && err.name === "NotFound") {
      return { ok: true, exists: false };
    }
    logger.error("storage object verification failed", { key, error: safeErrorMessage(err) });
    return { ok: false, error: "Failed to verify the uploaded file." };
  }
}
