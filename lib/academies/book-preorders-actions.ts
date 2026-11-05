"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  createPreorder,
  givePreorderBooks,
  recordPreorderPayment,
  recordPreorderReceipt,
  saveCampaign,
  setCampaignStatus,
  verifyPreorderPayment,
  type CampaignInput,
  type CreatePreorderInput,
  type GivePreorderBooksInput,
  type PreorderActionError,
  type RecordPreorderPaymentInput,
  type RecordReceiptInput,
} from "@/lib/academies/book-preorders";
import type { CampaignStatus } from "@/lib/academies/book-preorder-math";

/**
 * Server actions for book pre-orders. Each one only resolves the signed-in
 * actor and calls the service (lib/academies/book-preorders.ts), which owns
 * every permission, tenant, branch, money and stock rule. The whole Books
 * layout revalidates, because its header totals cover every section.
 */

const UNAUTHENTICATED: PreorderActionError = { code: "forbidden", message: "You must be signed in." };

export interface PreorderActionState {
  ok: boolean;
  error?: PreorderActionError;
  id?: string;
  reference?: string;
  balanceCents?: number;
  duplicate?: boolean;
}

function refresh() {
  revalidatePath("/academy/books", "layout");
}

export async function saveCampaignAction(campaignId: string | null, input: CampaignInput): Promise<PreorderActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await saveCampaign(context, campaignId, input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true, id: result.campaignId };
}

export async function setCampaignStatusAction(campaignId: string, status: CampaignStatus): Promise<PreorderActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await setCampaignStatus(context, campaignId, status);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true, id: result.campaignId };
}

export async function createPreorderAction(input: CreatePreorderInput): Promise<PreorderActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await createPreorder(context, input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true, id: result.orderId, reference: result.reference, duplicate: result.duplicate };
}

export async function recordPreorderPaymentAction(input: RecordPreorderPaymentInput): Promise<PreorderActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await recordPreorderPayment(context, input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true, id: result.paymentId, balanceCents: result.balanceCents, duplicate: result.duplicate };
}

export async function verifyPreorderPaymentAction(paymentId: string): Promise<PreorderActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await verifyPreorderPayment(context, paymentId);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true };
}

export async function recordPreorderReceiptAction(input: RecordReceiptInput): Promise<PreorderActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await recordPreorderReceipt(context, input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true, id: result.receiptId, duplicate: result.duplicate };
}

export async function givePreorderBooksAction(input: GivePreorderBooksInput): Promise<PreorderActionState> {
  const context = await getAuthContext();
  if (!context) return { ok: false, error: UNAUTHENTICATED };
  const result = await givePreorderBooks(context, input);
  if (!result.ok) return { ok: false, error: result.error };
  refresh();
  return { ok: true, id: result.handoverId, duplicate: result.duplicate };
}
