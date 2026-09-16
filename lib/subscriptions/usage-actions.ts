"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  recalculateUsage as recalculateUsageForActor,
  type AcademyUsageSnapshot,
  type UsageActionError,
} from "@/lib/subscriptions/usage";

const UNAUTHENTICATED: UsageActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export type RecalculateUsageActionResult =
  | { ok: true; usage: AcademyUsageSnapshot }
  | { ok: false; error: UsageActionError };

/**
 * "use server" wrapper for the /platform/usage page's per-academy
 * "Recalculate" button (DESIGN.md §7: "/platform/usage ... over-limit rows
 * visually flagged"). Called directly from a Client Component's onClick —
 * same convention as lib/subscriptions/plans-actions.ts's setPlanActive
 * (fire-and-check-result, not a <form>/useActionState binding, since there
 * is no field-level form input here beyond the academy being recalculated).
 */
export async function recalculateUsageAction(
  academyId: string,
): Promise<RecalculateUsageActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await recalculateUsageForActor(context, academyId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/platform/usage");
  return { ok: true, usage: result.usage };
}
