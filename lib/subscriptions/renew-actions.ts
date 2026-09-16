"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  renewSubscription as renewSubscriptionForActor,
  type RenewSubscriptionError,
} from "@/lib/subscriptions/renew";

const UNAUTHENTICATED: RenewSubscriptionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export type RenewSubscriptionActionResult =
  | { ok: true }
  | { ok: false; error: RenewSubscriptionError };

/**
 * Thin "use server" wrapper, matching lib/subscriptions/payments-actions.ts's
 * convention for a single fire-and-check-result row action (no
 * useActionState — the /platform/subscriptions Renew button is a plain
 * confirm-then-call action, not a multi-field form).
 */
export async function renewSubscription(
  subscriptionId: string,
): Promise<RenewSubscriptionActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await renewSubscriptionForActor(context, { subscriptionId });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/platform/subscriptions");
  return { ok: true };
}
