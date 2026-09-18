"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  markNotificationRead as markNotificationReadForActor,
  markNotificationsRead as markNotificationsReadForActor,
  type NotificationActionError,
} from "@/lib/notifications/list-notifications";

/**
 * Thin `"use server"` wrappers over lib/notifications/list-notifications.ts,
 * same convention as lib/academies/certificates-actions.ts over
 * lib/academies/certificates.ts.
 */
const UNAUTHENTICATED: NotificationActionError = {
  code: "not_found",
  message: "You must be signed in.",
};

export type MarkNotificationReadActionResult =
  | { ok: true }
  | { ok: false; error: NotificationActionError };

export async function markNotificationReadAction(
  notificationId: string,
): Promise<MarkNotificationReadActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await markNotificationReadForActor(context, notificationId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/notifications");
  return { ok: true };
}

export type MarkNotificationsReadActionResult =
  | { ok: true; markedCount: number }
  | { ok: false; error: NotificationActionError };

export async function markNotificationsReadAction(
  notificationIds: string[],
): Promise<MarkNotificationsReadActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await markNotificationsReadForActor(context, notificationIds);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/notifications");
  return { ok: true, markedCount: result.markedCount };
}
