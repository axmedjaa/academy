"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  recordSubscriptionPayment as recordSubscriptionPaymentForActor,
  verifySubscriptionPayment as verifySubscriptionPaymentForActor,
  rejectSubscriptionPayment as rejectSubscriptionPaymentForActor,
  reverseSubscriptionPayment as reverseSubscriptionPaymentForActor,
  type PaymentActionError,
  type RecordPaymentInput,
} from "@/lib/subscriptions/payments";

const UNAUTHENTICATED: PaymentActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface PaymentFormState {
  ok: boolean;
  error?: PaymentActionError;
}

/**
 * FormData -> RecordPaymentInput. Left loose/untyped-looking on purpose —
 * every field is re-validated by lib/subscriptions/payments.ts's Zod schema
 * right after this runs, matching lib/subscriptions/plans-actions.ts's
 * parsePlanFormData convention (shape translation only, not validation).
 */
function parseRecordPaymentFormData(formData: FormData): RecordPaymentInput {
  const paymentReference = String(formData.get("paymentReference") ?? "").trim();
  const evidenceFileRef = String(formData.get("evidenceFileRef") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  return {
    academyId: String(formData.get("academyId") ?? ""),
    subscriptionId: String(formData.get("subscriptionId") ?? ""),
    amountCents: Number(formData.get("amountCents")),
    currency: String(formData.get("currency") ?? ""),
    paymentMethod: String(formData.get("paymentMethod") ?? ""),
    paymentReference: paymentReference.length > 0 ? paymentReference : null,
    evidenceFileRef: evidenceFileRef.length > 0 ? evidenceFileRef : null,
    receivedAt: String(formData.get("receivedAt") ?? ""),
    notes: notes.length > 0 ? notes : null,
  };
}

/**
 * PLAN.md §4 server action name. Form-bound via useActionState (same
 * pattern as lib/subscriptions/plans-actions.ts's createSubscriptionPlan)
 * since the Record-Payment form has field-level validation errors to
 * surface.
 */
export async function recordSubscriptionPayment(
  _prevState: PaymentFormState,
  formData: FormData,
): Promise<PaymentFormState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await recordSubscriptionPaymentForActor(
    context,
    parseRecordPaymentFormData(formData),
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/platform/payments");
  return { ok: true };
}

/**
 * PLAN.md §4 server action names. Called directly (not through
 * useActionState) from each row's Verify/Reject/Reverse confirmation,
 * matching lib/subscriptions/plans-actions.ts's setPlanActive pattern for a
 * single fire-and-check-result action. DESIGN.md §8: each row action carries
 * "a reason-required confirmation" — the reason is collected by the
 * confirmation UI and passed straight through.
 */
export async function verifySubscriptionPayment(
  paymentId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: PaymentActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await verifySubscriptionPaymentForActor(context, paymentId, {
    reason,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/platform/payments");
  return { ok: true };
}

export async function rejectSubscriptionPayment(
  paymentId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: PaymentActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await rejectSubscriptionPaymentForActor(context, paymentId, {
    reason,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/platform/payments");
  return { ok: true };
}

export async function reverseSubscriptionPayment(
  paymentId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: PaymentActionError }> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await reverseSubscriptionPaymentForActor(context, paymentId, {
    reason,
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/platform/payments");
  return { ok: true };
}
