"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import {
  cancelCertificate as cancelCertificateForActor,
  issueCertificate as issueCertificateForActor,
  type CertificateActionError,
} from "@/lib/academies/certificates";

/**
 * PLAN.md Phase 5, Item 57's two server actions (issueCertificate/
 * cancelCertificate), thin `"use server"` wrappers over
 * lib/academies/certificates.ts — same convention as
 * lib/academies/student-payments-actions.ts's confirm-and-fire button
 * actions. A future, separate Phase 5 item wires these into
 * `/academy/certificates` (not built in this wave); `revalidatePath` still
 * targets that route now so it's correct once that UI exists.
 */
const UNAUTHENTICATED: CertificateActionError = {
  code: "forbidden",
  message: "You must be signed in.",
};

export type IssueCertificateActionResult =
  | { ok: true; certificateId: string }
  | { ok: false; error: CertificateActionError };

export async function issueCertificateAction(
  studentId: string,
  batchId: string,
): Promise<IssueCertificateActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await issueCertificateForActor(context, studentId, batchId);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/certificates");
  return { ok: true, certificateId: result.certificate.id };
}

export type CancelCertificateActionResult =
  | { ok: true }
  | { ok: false; error: CertificateActionError };

export async function cancelCertificateAction(
  certificateId: string,
  reason: string,
): Promise<CancelCertificateActionResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const result = await cancelCertificateForActor(context, certificateId, reason);
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  revalidatePath("/academy/certificates");
  return { ok: true };
}
