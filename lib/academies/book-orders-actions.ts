"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  cancelBookOrder,
  createBookOrder,
  issueBooksToStudent,
  recordBookOrderPayment,
  updateBookOrderDiscount,
  type BookOrderError,
  type CreateBookOrderInput,
  type IssueBooksInput,
  type RecordBookOrderPaymentInput,
  type UpdateBookOrderDiscountInput,
} from "@/lib/academies/book-orders";

/**
 * Server actions for book orders (for a student or another person), the
 * buyer's payments, discounts and books
 * issued. Each one only resolves the signed-in actor and calls
 * lib/academies/book-orders.ts, which owns every permission, tenant, branch,
 * money and stock rule.
 */

const UNAUTHENTICATED: BookOrderError = { code: "forbidden", message: "You must be signed in." };

export interface BookOrderActionState {
  ok: boolean;
  error?: BookOrderError;
  id?: string;
  duplicate?: boolean;
}

function refresh(studentId?: string) {
  revalidatePath("/academy/books", "layout");
  if (studentId) revalidatePath(`/academy/students/${studentId}`);
}

export async function createBookOrderAction(input: CreateBookOrderInput): Promise<BookOrderActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await createBookOrder(context, input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true, id: result.orderId, duplicate: result.duplicate };
}

export async function cancelBookOrderAction(orderId: string): Promise<BookOrderActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await cancelBookOrder(context, orderId);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true, id: orderId };
}

export async function recordBookOrderPaymentAction(input: RecordBookOrderPaymentInput): Promise<BookOrderActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await recordBookOrderPayment(context, input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true, id: result.paymentId, duplicate: result.duplicate };
}

export async function issueBooksAction(input: IssueBooksInput): Promise<BookOrderActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await issueBooksToStudent(context, input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh(input.studentId);
  return { ok: true, id: result.issueId, duplicate: result.duplicate };
}

export async function updateBookOrderDiscountAction(input: UpdateBookOrderDiscountInput): Promise<BookOrderActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await updateBookOrderDiscount(context, input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true, id: input.orderId };
}
