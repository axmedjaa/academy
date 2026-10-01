import { and, eq, ilike, or } from "drizzle-orm";
import { z } from "zod";
import { db, type DbClient } from "@/lib/db";
import { academies, books } from "@/lib/db/schema";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  ACADEMY_BOOKS_ACTION,
  getAcademyPermissionLevel,
  type AcademyPermissionLevel,
} from "@/lib/auth/academy-permissions";
import { recordAudit } from "@/lib/audit";
import { deleteObject, getDownloadUrl, getUploadUrl, headObject } from "@/lib/storage/client";
import { getBookCoverKey, isBookCoverKey } from "@/lib/storage/keys";
import { logger } from "@/lib/logger";
import type { AuthContext } from "@/lib/auth/auth-context";
import type { AcademyRole } from "@/lib/auth/roles";

/**
 * Academy Books catalogue (§32-40). No approval workflow — "manage" is the
 * top level anyone reaches (see ACADEMY_BOOKS_ACTION's own comment in
 * lib/auth/academy-permissions.ts). Cover upload reuses the exact R2
 * presigned-PUT/headObject-verify pattern from
 * lib/academies/academy-logo.ts, just re-targeted at one book per key
 * instead of one academy.
 */
function canManage(level: AcademyPermissionLevel): boolean {
  return level === "manage";
}

export interface BookActionError {
  code: "forbidden" | "validation" | "not_found" | "blocked" | "upload_failed" | "verification_failed";
  message: string;
}

const FORBIDDEN: BookActionError = {
  code: "forbidden",
  message: "You don't have permission to view or manage this academy's books.",
};

const NOT_FOUND: BookActionError = { code: "not_found", message: "Book not found." };

interface ResolvedBooksAccess {
  academyId: string;
  membershipRole: AcademyRole;
  permissionLevel: AcademyPermissionLevel;
}

type ResolveBooksAccessResult = { ok: true; access: ResolvedBooksAccess } | { ok: false; error: BookActionError };

async function resolveBooksAccess(actorContext: AuthContext): Promise<ResolveBooksAccessResult> {
  const access = await checkAcademyAccessForContext(actorContext);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }
  const permissionLevel = getAcademyPermissionLevel(access.membershipRole, ACADEMY_BOOKS_ACTION);
  if (permissionLevel === "none") {
    return { ok: false, error: FORBIDDEN };
  }
  return { ok: true, access: { academyId: access.academyId, membershipRole: access.membershipRole, permissionLevel } };
}

async function resolveCurrency(executor: DbClient, academyId: string, provided: string | undefined): Promise<string> {
  if (provided) return provided;
  const [academy] = await executor
    .select({ defaultCurrency: academies.defaultCurrency })
    .from(academies)
    .where(eq(academies.id, academyId))
    .limit(1);
  return academy?.defaultCurrency ?? "USD";
}

// ===========================================================================
// Cover-image verification — shared by `createBook` (a NEW book's cover,
// uploaded before the row exists) and `confirmBookCoverUpload` (an EXISTING
// book's replacement cover). Both paths must apply the exact same
// content-type/size authority check against the real uploaded object, never
// the client's claims — defined once here so neither can drift.
// ===========================================================================

export const MAX_COVER_SIZE_BYTES = 5 * 1024 * 1024;
const ALLOWED_COVER_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
type AllowedCoverContentType = (typeof ALLOWED_COVER_CONTENT_TYPES)[number];
const EXTENSION_BY_CONTENT_TYPE: Record<AllowedCoverContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function isAllowedContentType(value: string): value is AllowedCoverContentType {
  return (ALLOWED_COVER_CONTENT_TYPES as readonly string[]).includes(value);
}

const INVALID_FORMAT: BookActionError = { code: "validation", message: "Cover image must be JPEG, PNG, or WebP." };
const TOO_LARGE: BookActionError = { code: "validation", message: "Cover image must be 5 MB or smaller." };
const VERIFICATION_FAILED: BookActionError = { code: "verification_failed", message: "The cover upload could not be verified." };

type VerifyCoverUploadResult = { ok: true } | { ok: false; error: BookActionError };

/**
 * Re-verifies an already-PUT-to-R2 object actually matches this academy's
 * key shape and the allowed format/size — the real authority, never the
 * client's claims from the presigned-URL request step. An object that fails
 * verification is deleted from R2 immediately (never left orphaned). Shared
 * by `createBook` and `confirmBookCoverUpload` — see this section's own
 * header comment.
 */
async function verifyCoverUpload(key: string, academyId: string): Promise<VerifyCoverUploadResult> {
  if (!isBookCoverKey(key, academyId)) {
    return { ok: false, error: { code: "validation", message: "Invalid upload reference." } };
  }
  const head = await headObject(key);
  if (!head.ok) return { ok: false, error: VERIFICATION_FAILED };
  if (!head.exists) {
    return { ok: false, error: { code: "not_found", message: "The uploaded file could not be found. Please try uploading again." } };
  }
  if (!head.info.contentType || !isAllowedContentType(head.info.contentType)) {
    await deleteObject(key);
    return { ok: false, error: INVALID_FORMAT };
  }
  if (!head.info.contentLength || head.info.contentLength > MAX_COVER_SIZE_BYTES) {
    await deleteObject(key);
    return { ok: false, error: TOO_LARGE };
  }
  return { ok: true };
}

// Stock-status bucketing (LOW_STOCK_THRESHOLD/StockStatus/getStockStatus)
// lives in lib/academies/book-stock.ts — a pure, server/client-safe module
// — and is re-exported here so existing server-side importers of
// lib/academies/books.ts keep working unchanged. The Stock page's client
// component imports directly from book-stock.ts instead of here, so it
// never pulls this file's `pg`-dependent server code into the browser
// bundle (next build caught exactly that when this lived only in this file).
export { LOW_STOCK_THRESHOLD, getStockStatus, type StockStatus } from "@/lib/academies/book-stock";

export interface BookRecord {
  id: string;
  academyId: string;
  name: string;
  description: string | null;
  author: string | null;
  isbn: string | null;
  category: string | null;
  priceCents: number;
  currency: string;
  stockQuantity: number;
  coverRef: string | null;
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
}

function toBookRecord(row: typeof books.$inferSelect): BookRecord {
  return {
    id: row.id,
    academyId: row.academyId,
    name: row.name,
    description: row.description,
    author: row.author,
    isbn: row.isbn,
    category: row.category,
    priceCents: row.priceCents,
    currency: row.currency,
    stockQuantity: row.stockQuantity,
    coverRef: row.coverRef,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function optionalText(maxLength = 500) {
  return z
    .string()
    .trim()
    .max(maxLength)
    .optional()
    .or(z.literal(""))
    .transform((value) => (value && value.length > 0 ? value : undefined));
}

export const createBookSchema = z.object({
  name: z.string().trim().min(1, "Book name is required").max(300),
  description: optionalText(2000),
  author: optionalText(200),
  isbn: optionalText(50),
  category: optionalText(100),
  priceCents: z.number().int("Price must be a whole number of cents").nonnegative("Price cannot be negative"),
  currency: z.string().trim().toUpperCase().length(3, "Currency must be a 3-letter code, e.g. USD").optional(),
  stockQuantity: z.number().int("Stock must be a whole number").nonnegative("Stock cannot be negative"),
  // The R2 key of an already-uploaded (but not yet DB-confirmed) cover —
  // see `requestNewBookCoverUploadUrl`'s own doc comment for why a NEW
  // book's cover is uploaded before the book row exists, unlike an EXISTING
  // book's cover replace flow (requestBookCoverUploadUrl/
  // confirmBookCoverUpload, which still needs a bookId). Required: every
  // newly created book must have a cover (this task's own requirement) —
  // legacy books created before this requirement remain nullable and
  // unaffected (display falls back to a placeholder, see books-manager.tsx).
  coverRef: z.string().trim().min(1, "A cover image is required."),
});

export type CreateBookInput = z.input<typeof createBookSchema>;

export type CreateBookResult = { ok: true; book: BookRecord } | { ok: false; error: BookActionError };

export async function createBook(actorContext: AuthContext, input: CreateBookInput): Promise<CreateBookResult> {
  const resolved = await resolveBooksAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;
  if (!canManage(permissionLevel)) return { ok: false, error: FORBIDDEN };

  const parsed = createBookSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }
  const data = parsed.data;

  const coverVerification = await verifyCoverUpload(data.coverRef, academyId);
  if (!coverVerification.ok) return { ok: false, error: coverVerification.error };

  const result = await db.transaction(async (tx) => {
    const currency = await resolveCurrency(tx, academyId, data.currency);
    const [row] = await tx
      .insert(books)
      .values({
        academyId,
        name: data.name,
        description: data.description,
        author: data.author,
        isbn: data.isbn,
        category: data.category,
        priceCents: data.priceCents,
        currency,
        stockQuantity: data.stockQuantity,
        coverRef: data.coverRef,
        createdBy: actorContext.userId,
      })
      .returning();

    await recordAudit(
      { actorUserId: actorContext.userId, actorRole: membershipRole, academyId, action: "createBook", entityType: "book", entityId: row.id, after: toBookRecord(row) },
      tx,
    );
    return row;
  });

  return { ok: true, book: toBookRecord(result) };
}

export const updateBookSchema = z.object({
  name: z.string().trim().min(1, "Book name is required").max(300).optional(),
  description: optionalText(2000),
  author: optionalText(200),
  isbn: optionalText(50),
  category: optionalText(100),
  priceCents: z.number().int("Price must be a whole number of cents").nonnegative("Price cannot be negative").optional(),
  stockQuantity: z.number().int("Stock must be a whole number").nonnegative("Stock cannot be negative").optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export type UpdateBookInput = z.input<typeof updateBookSchema>;

export type UpdateBookResult = { ok: true; book: BookRecord } | { ok: false; error: BookActionError };

async function getScopedBook(executor: DbClient, bookId: string, academyId: string) {
  const [row] = await executor.select().from(books).where(eq(books.id, bookId)).limit(1);
  if (!row || row.academyId !== academyId) return null;
  return row;
}

export async function updateBook(actorContext: AuthContext, bookId: string, input: UpdateBookInput): Promise<UpdateBookResult> {
  const resolved = await resolveBooksAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;
  if (!canManage(permissionLevel)) return { ok: false, error: FORBIDDEN };

  const parsedId = z.string().uuid().safeParse(bookId);
  if (!parsedId.success) return { ok: false, error: NOT_FOUND };

  const parsed = updateBookSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "validation", message: parsed.error.issues[0]?.message ?? "Invalid input." } };
  }
  const data = parsed.data;

  const result = await db.transaction(async (tx) => {
    const existing = await getScopedBook(tx, bookId, academyId);
    if (!existing) return null;

    const [row] = await tx
      .update(books)
      .set({
        name: data.name ?? existing.name,
        description: data.description !== undefined ? data.description : existing.description,
        author: data.author !== undefined ? data.author : existing.author,
        isbn: data.isbn !== undefined ? data.isbn : existing.isbn,
        category: data.category !== undefined ? data.category : existing.category,
        priceCents: data.priceCents ?? existing.priceCents,
        stockQuantity: data.stockQuantity ?? existing.stockQuantity,
        status: data.status ?? existing.status,
        updatedAt: new Date(),
      })
      .where(eq(books.id, bookId))
      .returning();

    await recordAudit(
      { actorUserId: actorContext.userId, actorRole: membershipRole, academyId, action: "updateBook", entityType: "book", entityId: row.id, before: toBookRecord(existing), after: toBookRecord(row) },
      tx,
    );

    // A distinct, specifically-named event for stock changes (as opposed to
    // the generic "updateBook" above) so stock movements are independently
    // auditable/searchable — only fired when stock actually moved, never on
    // every edit of an unrelated field (name, price, etc.).
    if (data.stockQuantity !== undefined && data.stockQuantity !== existing.stockQuantity) {
      await recordAudit(
        {
          actorUserId: actorContext.userId,
          actorRole: membershipRole,
          academyId,
          action: "bookStockChanged",
          entityType: "book",
          entityId: row.id,
          before: { stockQuantity: existing.stockQuantity },
          after: { stockQuantity: row.stockQuantity },
          context: { source: "manual_update", delta: row.stockQuantity - existing.stockQuantity },
        },
        tx,
      );
    }
    return row;
  });

  if (!result) return { ok: false, error: NOT_FOUND };
  return { ok: true, book: toBookRecord(result) };
}

export type ListBooksResult = { ok: true; books: BookRecord[]; canManage: boolean } | { ok: false; error: BookActionError };

export async function listBooks(
  actorContext: AuthContext,
  filters: { search?: string; status?: "active" | "inactive" } = {},
): Promise<ListBooksResult> {
  const resolved = await resolveBooksAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, permissionLevel } = resolved.access;

  const conditions = [eq(books.academyId, academyId)];
  if (filters.status) conditions.push(eq(books.status, filters.status));
  if (filters.search && filters.search.trim().length > 0) {
    const term = `%${filters.search.trim()}%`;
    // Matches name, ISBN, or author — a staff member looking up a book
    // rarely has the exact catalogue name on hand but often has the ISBN
    // printed on the back cover, or remembers the author.
    conditions.push(or(ilike(books.name, term), ilike(books.isbn, term), ilike(books.author, term))!);
  }

  const rows = await db.select().from(books).where(and(...conditions));
  return { ok: true, books: rows.map(toBookRecord), canManage: canManage(permissionLevel) };
}

export type GetBookResult = { ok: true; book: BookRecord } | { ok: false; error: BookActionError };

export async function getBook(actorContext: AuthContext, bookId: string): Promise<GetBookResult> {
  const resolved = await resolveBooksAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId } = resolved.access;

  const parsedId = z.string().uuid().safeParse(bookId);
  if (!parsedId.success) return { ok: false, error: NOT_FOUND };

  const row = await getScopedBook(db, bookId, academyId);
  if (!row) return { ok: false, error: NOT_FOUND };
  return { ok: true, book: toBookRecord(row) };
}

// ===========================================================================
// Cover upload — same three-step presigned-URL flow as
// lib/academies/academy-logo.ts (requestUploadUrl -> browser PUT ->
// confirmUpload with server-side headObject verification). The
// content-type/size constants and `verifyCoverUpload` live earlier in this
// file (right after `resolveCurrency`) since `createBook` needs them too.
// ===========================================================================

export type RequestBookCoverUploadUrlResult =
  | { ok: true; uploadUrl: string; key: string; expiresInSeconds: number }
  | { ok: false; error: BookActionError };

export async function requestBookCoverUploadUrl(
  actorContext: AuthContext,
  bookId: string,
  input: { contentType: string; fileSizeBytes: number },
): Promise<RequestBookCoverUploadUrlResult> {
  const resolved = await resolveBooksAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, permissionLevel } = resolved.access;
  if (!canManage(permissionLevel)) return { ok: false, error: FORBIDDEN };

  const book = await getScopedBook(db, bookId, academyId);
  if (!book) return { ok: false, error: NOT_FOUND };

  return requestCoverUploadUrlFor(academyId, input);
}

/**
 * Step 1 for a NEW book's cover — no bookId exists yet, so this skips
 * `getScopedBook` entirely and only checks permission. The key is
 * academy-scoped (never book-scoped — see lib/storage/keys.ts's
 * `getBookCoverKey`), so it can be generated and uploaded to before the
 * book row is created, then passed straight into `createBookSchema.coverRef`
 * for `createBook` to verify and persist in one step. This is what lets
 * "every new book must have a cover" be enforced server-side without a
 * two-phase "create a coverless book, then force a cover onto it" dance.
 */
export async function requestNewBookCoverUploadUrl(
  actorContext: AuthContext,
  input: { contentType: string; fileSizeBytes: number },
): Promise<RequestBookCoverUploadUrlResult> {
  const resolved = await resolveBooksAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, permissionLevel } = resolved.access;
  if (!canManage(permissionLevel)) return { ok: false, error: FORBIDDEN };

  return requestCoverUploadUrlFor(academyId, input);
}

async function requestCoverUploadUrlFor(
  academyId: string,
  input: { contentType: string; fileSizeBytes: number },
): Promise<RequestBookCoverUploadUrlResult> {
  if (!isAllowedContentType(input.contentType)) return { ok: false, error: INVALID_FORMAT };
  if (!Number.isFinite(input.fileSizeBytes) || input.fileSizeBytes <= 0 || input.fileSizeBytes > MAX_COVER_SIZE_BYTES) {
    return { ok: false, error: TOO_LARGE };
  }

  const key = getBookCoverKey({ academyId, extension: EXTENSION_BY_CONTENT_TYPE[input.contentType] });
  const result = await getUploadUrl({ key, contentType: input.contentType });
  if (!result.ok) {
    return { ok: false, error: { code: "upload_failed", message: "The cover upload could not be started. Please try again." } };
  }
  return { ok: true, uploadUrl: result.uploadUrl, key, expiresInSeconds: result.expiresInSeconds };
}

export type ConfirmBookCoverUploadResult = { ok: true; coverRef: string } | { ok: false; error: BookActionError };

export async function confirmBookCoverUpload(
  actorContext: AuthContext,
  bookId: string,
  input: { key: string },
): Promise<ConfirmBookCoverUploadResult> {
  const resolved = await resolveBooksAccess(actorContext);
  if (!resolved.ok) return resolved;
  const { academyId, membershipRole, permissionLevel } = resolved.access;
  if (!canManage(permissionLevel)) return { ok: false, error: FORBIDDEN };

  const verification = await verifyCoverUpload(input.key, academyId);
  if (!verification.ok) return { ok: false, error: verification.error };

  const result = await db.transaction(async (tx) => {
    const existing = await getScopedBook(tx, bookId, academyId);
    if (!existing) return null;

    const previousKey = existing.coverRef;
    await tx.update(books).set({ coverRef: input.key, updatedAt: new Date() }).where(eq(books.id, bookId));

    await recordAudit(
      { actorUserId: actorContext.userId, actorRole: membershipRole, academyId, action: previousKey ? "replaceBookCover" : "uploadBookCover", entityType: "book", entityId: bookId, before: { coverRef: previousKey }, after: { coverRef: input.key } },
      tx,
    );
    return { previousKey };
  });

  if (!result) return { ok: false, error: NOT_FOUND };

  if (result.previousKey && result.previousKey !== input.key) {
    const deleted = await deleteObject(result.previousKey);
    if (!deleted.ok) {
      logger.warn("book cover replacement: old R2 object could not be deleted (orphaned)", { bookId });
    }
  }

  return { ok: true, coverRef: input.key };
}

/** Same "display-field fetch on an already-authorized value" pattern as
 * lib/academies/academy-logo.ts's `getAcademyLogoUrl`. */
export async function getBookCoverUrl(coverRef: string | null): Promise<string | null> {
  if (!coverRef) return null;
  const result = await getDownloadUrl({ key: coverRef });
  return result.ok ? result.downloadUrl : null;
}

export { ALLOWED_COVER_CONTENT_TYPES };
