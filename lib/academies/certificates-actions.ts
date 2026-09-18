"use server";

import { revalidatePath } from "next/cache";
import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  cancelCertificate as cancelCertificateForActor,
  issueCertificate as issueCertificateForActor,
  verifyCertificate,
  type CertificateActionError,
  type PublicCertificateVerification,
  type VerifyCertificateError,
} from "@/lib/academies/certificates";

/**
 * PLAN.md Phase 5, Item 57's two server actions (issueCertificate/
 * cancelCertificate), thin `"use server"` wrappers over
 * lib/academies/certificates.ts — same convention as
 * lib/academies/student-payments-actions.ts's confirm-and-fire button
 * actions. `verifyCertificateInternalAction` (further down this file) was
 * added alongside app/academy/certificates/page.tsx, the wave that finally
 * wires all three into `/academy/certificates`.
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

export type VerifyCertificateInternalResult =
  | { ok: true; certificate: PublicCertificateVerification }
  | { ok: false; error: CertificateActionError | VerifyCertificateError };

/**
 * DESIGN.md §9.7 "Certificate Verification (internal lookup)" — "Read-only
 * detail identical in content to the public page (§10) but reachable from
 * inside the app for staff use." Reuses `verifyCertificate` verbatim (same
 * query, same exact 4-field response shape) rather than re-deriving the
 * same student/program join a second time — the only addition here is an
 * authentication + active-membership gate in front of it, since this is
 * reached from inside the authenticated app rather than the public
 * `/verify/[code]` route.
 *
 * Rate-limited the same way `verifyCertificate` always is, but keyed per
 * staff member (`internal:${userId}`) rather than per IP — this call site
 * has a real authenticated identity, so scoping the limit to it (instead of
 * the shared literal "internal") means one busy staff member's lookups
 * never exhaust another's budget. Documented judgment call: `ip` is
 * `verifyCertificate`'s literal rate-limit-key/audit-log parameter name,
 * repurposed here for an authenticated caller rather than a real IP.
 */
export async function verifyCertificateInternalAction(
  certificateCode: string,
): Promise<VerifyCertificateInternalResult> {
  const context = await getAuthContext();
  if (!context) {
    return { ok: false, error: UNAUTHENTICATED };
  }

  const access = await checkAcademyAccessForContext(context);
  if (access.level === "blocked") {
    return { ok: false, error: { code: "blocked", message: access.message } };
  }

  return verifyCertificate(certificateCode, `internal:${context.userId}`);
}
