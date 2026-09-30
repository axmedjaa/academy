"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  addBookSalePayment as addBookSalePaymentForActor,
  createBookSale as createBookSaleForActor,
  refundBookSale as refundBookSaleForActor,
  type AddBookSalePaymentInput,
  type BookSaleActionError,
  type CreateBookSaleInput,
  type RefundBookSaleInput,
} from "@/lib/academies/book-sales";

const UNAUTHENTICATED: BookSaleActionError = { code: "forbidden", message: "You must be signed in." };

export interface BookSaleFormState {
  ok: boolean;
  error?: BookSaleActionError;
}

export async function createBookSaleAction(input: CreateBookSaleInput): Promise<BookSaleFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await createBookSaleForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/books");
  revalidatePath("/academy/books/sales");
  return { ok: true };
}

export async function addBookSalePaymentAction(input: AddBookSalePaymentInput): Promise<BookSaleFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await addBookSalePaymentForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/books/sales");
  return { ok: true };
}

export async function refundBookSaleAction(input: RefundBookSaleInput): Promise<BookSaleFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await refundBookSaleForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/books");
  revalidatePath("/academy/books/sales");
  return { ok: true };
}
