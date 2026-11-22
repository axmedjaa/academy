"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  confirmBookCoverUpload as confirmBookCoverUploadForActor,
  removeBookCover as removeBookCoverForActor,
  createBook as createBookForActor,
  requestBookCoverUploadUrl as requestBookCoverUploadUrlForActor,
  requestNewBookCoverUploadUrl as requestNewBookCoverUploadUrlForActor,
  updateBook as updateBookForActor,
  adjustBookStock as adjustBookStockForActor,
  type AdjustBookStockInput,
  type BookActionError,
  type CreateBookInput,
  type UpdateBookInput,
} from "@/lib/academies/books";

const UNAUTHENTICATED: BookActionError = { code: "forbidden", message: "You must be signed in." };

export interface BookFormState {
  ok: boolean;
  error?: BookActionError;
  bookId?: string;
}

export async function createBookAction(input: CreateBookInput): Promise<BookFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await createBookForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/books");
  return { ok: true, bookId: result.book.id };
}

export async function updateBookAction(bookId: string, input: UpdateBookInput): Promise<BookFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await updateBookForActor(context, bookId, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/books");
  return { ok: true, bookId: result.book.id };
}

export async function adjustBookStockAction(bookId: string, input: AdjustBookStockInput): Promise<BookFormState & { stockQuantity?: number }> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await adjustBookStockForActor(context, bookId, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/books");
  return { ok: true, bookId: result.book.id, stockQuantity: result.book.stockQuantity };
}

export interface RequestBookCoverUploadUrlState {
  ok: boolean;
  error?: BookActionError;
  uploadUrl?: string;
  key?: string;
}

export async function requestBookCoverUploadUrlAction(
  bookId: string,
  input: { contentType: string; fileSizeBytes: number },
): Promise<RequestBookCoverUploadUrlState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await requestBookCoverUploadUrlForActor(context, bookId, input);
  if (!result.ok) return { ok: false, error: result.error };

  return { ok: true, uploadUrl: result.uploadUrl, key: result.key };
}

/** Step 1 for a NEW book's cover (no bookId yet) — see
 * `requestNewBookCoverUploadUrl`'s own doc comment in lib/academies/books.ts. */
export async function requestNewBookCoverUploadUrlAction(
  input: { contentType: string; fileSizeBytes: number },
): Promise<RequestBookCoverUploadUrlState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await requestNewBookCoverUploadUrlForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };

  return { ok: true, uploadUrl: result.uploadUrl, key: result.key };
}

export interface ConfirmBookCoverUploadState {
  ok: boolean;
  error?: BookActionError;
}

export async function confirmBookCoverUploadAction(bookId: string, key: string): Promise<ConfirmBookCoverUploadState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await confirmBookCoverUploadForActor(context, bookId, { key });
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/books");
  return { ok: true };
}

export async function removeBookCoverAction(bookId: string): Promise<ConfirmBookCoverUploadState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await removeBookCoverForActor(context, bookId);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/books");
  return { ok: true };
}
