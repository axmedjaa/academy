"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  approveAcademy as approveAcademyForActor,
  type ApproveAcademyError,
} from "@/lib/academies/approve";

const UNAUTHENTICATED: ApproveAcademyError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export type ApproveAcademyActionResult =
  | { ok: true }
  | { ok: false; error: ApproveAcademyError };

/**
 * PLAN.md §4 server action name. Thin "use server" wrapper around the pure
 * lib/academies/approve.ts logic — same file-split convention as
 * lib/platform-staff/actions.ts. Called directly from the client Approve
 * button (app/platform/academies/[id]/approve-academy-button.tsx), not via
 * useActionState, since it's a single confirm-and-fire action with no
 * form fields of its own.
 */
export async function approveAcademyAction(
  academyId: string,
): Promise<ApproveAcademyActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await approveAcademyForActor(context, academyId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/platform/academies");
  revalidatePath(`/platform/academies/${academyId}`);
  return { ok: true };
}
