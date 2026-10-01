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
  /** Set on a successful `createBookSaleAction` — lets the UI link straight
   * to that sale's receipt immediately, without a page reload/refetch. */
  saleId?: string;
  /** Set on a successful `addBookSalePaymentAction` — lets the UI link
   * straight to THIS payment's own receipt (distinct from the sale's
   * overall receipt — see book-sale-receipt-print.ts's module comment on
   * why each payment gets its own, never conflated with the running total). */
  paymentId?: string;
}

export async function createBookSaleAction(input: CreateBookSaleInput): Promise<BookSaleFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await createBookSaleForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/books");
  revalidatePath("/academy/books/sales");
  return { ok: true, saleId: result.sale.id };
}

export async function addBookSalePaymentAction(input: AddBookSalePaymentInput): Promise<BookSaleFormState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };

  const result = await addBookSalePaymentForActor(context, input);
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath("/academy/books/sales");
  return { ok: true, saleId: result.sale.id, paymentId: result.paymentId };
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
