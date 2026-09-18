"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  setNotificationPreference as setNotificationPreferenceForActor,
  type NotificationPreferenceActionError,
  type NotificationPreferenceView,
} from "@/lib/notifications/preferences";

/**
 * Thin `"use server"` wrapper over lib/notifications/preferences.ts, same
 * convention as app/platform/academies/[id]/approve-academy-button.tsx's
 * `approveAcademyAction` — a direct-parameter action called imperatively
 * from a client component's `useTransition` handler (one call per toggle
 * flip), rather than a `useActionState`/FormData form, since each toggle
 * row is an independent immediate-save control, not a multi-field form
 * submission.
 */
const UNAUTHENTICATED: NotificationPreferenceActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export type SetNotificationPreferenceActionResult =
  | { ok: true; preference: NotificationPreferenceView }
  | { ok: false; error: NotificationPreferenceActionError };

export async function setNotificationPreferenceAction(
  academyId: string,
  templateId: string,
  enabled: boolean,
): Promise<SetNotificationPreferenceActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await setNotificationPreferenceForActor(context, academyId, templateId, enabled);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/settings");
  return { ok: true, preference: result.preference };
}
