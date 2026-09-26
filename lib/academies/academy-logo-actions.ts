"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  confirmAcademyLogoUpload as confirmAcademyLogoUploadForActor,
  removeAcademyLogo as removeAcademyLogoForActor,
  requestAcademyLogoUploadUrl as requestAcademyLogoUploadUrlForActor,
  type AcademyLogoActionError,
} from "@/lib/academies/academy-logo";

const UNAUTHENTICATED: AcademyLogoActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export interface RequestAcademyLogoUploadUrlState {
  ok: boolean;
  error?: AcademyLogoActionError;
  uploadUrl?: string;
  key?: string;
}

/**
 * Plain callables (no form fields to carry — the client drives this flow
 * via `fetch`/XHR against the returned presigned URL, not a form submit),
 * matching lib/auth/update-account-actions.ts's `resendEmailChangeVerification`
 * convention rather than `useActionState`. Each resolves the trusted
 * AuthContext server-side (never trusting a client-supplied actor) and
 * returns only a plain ok/error result.
 */
export async function requestAcademyLogoUploadUrlAction(input: {
  contentType: string;
  fileSizeBytes: number;
}): Promise<RequestAcademyLogoUploadUrlState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await requestAcademyLogoUploadUrlForActor(context, input);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true, uploadUrl: result.uploadUrl, key: result.key };
}

export interface ConfirmAcademyLogoUploadState {
  ok: boolean;
  error?: AcademyLogoActionError;
}

export async function confirmAcademyLogoUploadAction(key: string): Promise<ConfirmAcademyLogoUploadState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await confirmAcademyLogoUploadForActor(context, { key });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/settings");
  return { ok: true };
}

export interface RemoveAcademyLogoState {
  ok: boolean;
  error?: AcademyLogoActionError;
}

export async function removeAcademyLogoAction(): Promise<RemoveAcademyLogoState> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await removeAcademyLogoForActor(context);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/settings");
  return { ok: true };
}
