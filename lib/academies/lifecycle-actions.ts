"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  activateAcademy as activateAcademyForActor,
  cancelAcademy as cancelAcademyForActor,
  closeAcademy as closeAcademyForActor,
  reactivateAcademy as reactivateAcademyForActor,
  suspendAcademy as suspendAcademyForActor,
  type LifecycleActionError,
} from "@/lib/academies/lifecycle";

const UNAUTHENTICATED: LifecycleActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export type LifecycleActionResult =
  | { ok: true }
  | { ok: false; error: LifecycleActionError };

function revalidateAcademy(academyId: string): void {
  revalidatePath("/platform/academies");
  revalidatePath(`/platform/academies/${academyId}`);
}

/**
 * PLAN.md §4 server action names. Thin "use server" wrappers around the pure
 * lib/academies/lifecycle.ts logic — same file-split convention as
 * lib/academies/approve-actions.ts. Each resolves the trusted AuthContext
 * server-side (never trusting a client-supplied actor) and returns only a
 * plain ok/error result — never throws for an expected rejection.
 */

export async function activateAcademyAction(academyId: string): Promise<LifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await activateAcademyForActor(context, academyId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidateAcademy(academyId);
  return { ok: true };
}

export async function suspendAcademyAction(
  academyId: string,
  reason: string,
): Promise<LifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await suspendAcademyForActor(context, academyId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidateAcademy(academyId);
  return { ok: true };
}

export async function reactivateAcademyAction(
  academyId: string,
  reason?: string,
): Promise<LifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await reactivateAcademyForActor(context, academyId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidateAcademy(academyId);
  return { ok: true };
}

export async function cancelAcademyAction(
  academyId: string,
  reason: string,
): Promise<LifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await cancelAcademyForActor(context, academyId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidateAcademy(academyId);
  return { ok: true };
}

export async function closeAcademyAction(
  academyId: string,
  reason: string,
): Promise<LifecycleActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await closeAcademyForActor(context, academyId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidateAcademy(academyId);
  return { ok: true };
}
