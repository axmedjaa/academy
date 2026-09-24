"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  cancelCertificateAction,
  issueCertificateAction,
  verifyCertificateInternalAction,
} from "@/lib/academies/certificates-actions";
import {
  Badge,
  Button,
  ErrorMessage,
  Field,
  LinkButton,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";

export interface CertificateRow {
  id: string;
  certificateCode: string;
  studentId: string;
  studentName: string;
  batchId: string;
  batchName: string;
  programName: string;
  status: "issued" | "cancelled";
  issuedAt: Date;
  cancelledAt: Date | null;
  cancellationReason: string | null;
}

interface Props {
  certificates: CertificateRow[];
  canManage: boolean;
  /** Active students / all batches for the Issue form's pickers — see
   * page.tsx's own comment. Empty when `canManage` is false (the caller
   * never needs them). */
  studentOptions: { id: string; fullName: string; studentNumber: string }[];
  batchOptions: { id: string; name: string; code: string }[];
}

/**
 * DESIGN.md §9.7. Issue's Student/Batch fields are `<select>` pickers
 * (this wave) rather than free-text id inputs — pasting the studentNumber/
 * batch code shown everywhere else in the app into a raw "Student id" field
 * used to always fail with "Student not found." (lib/academies/certificates.ts's
 * issueCertificate now accepts either form, but a picker avoids the typo/
 * lookup problem entirely). Cancel's reveal-then-confirm pattern mirrors
 * app/academy/results/results-list.tsx's Reject flow exactly (same
 * "require a reason, confirmation before the destructive/terminal action"
 * shape DESIGN.md §3 Modal spec calls for) — not `ConfirmButton`, since
 * that component's dialog has no slot for a free-text reason field.
 *
 * Cancellation, never deletion: PLAN.md is explicit that certificates are
 * never hard-deleted (public verification must stay permanently
 * resolvable, even for a cancelled one) — `cancelCertificate` is the one
 * and only removal path, "Restorable: no" in the Archive & Deactivation
 * Rules table, so there is deliberately no Delete action anywhere on this
 * page.
 */
export function CertificatesList({ certificates, canManage, studentOptions, batchOptions }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [issueStudentId, setIssueStudentId] = useState("");
  const [issueBatchId, setIssueBatchId] = useState("");
  const [issueSuccess, setIssueSuccess] = useState<string | null>(null);

  function handleIssue() {
    setError(null);
    setIssueSuccess(null);
    startTransition(async () => {
      const result = await issueCertificateAction(issueStudentId, issueBatchId);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setIssueSuccess("Certificate issued.");
      setIssueStudentId("");
      setIssueBatchId("");
    });
  }

  function handleCancel(certificateId: string) {
    setError(null);
    startTransition(async () => {
      const result = await cancelCertificateAction(certificateId, cancelReason.trim());
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setCancellingId(null);
      setCancelReason("");
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <ErrorMessage message={error} />}

      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Student</th>
            <th className={th}>Program</th>
            <th className={th}>Batch</th>
            <th className={th}>Code</th>
            <th className={th}>Issued</th>
            <th className={th}>Status</th>
            <th className={th}>Certificate</th>
            {canManage && <th className={th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {certificates.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 8 : 7} className={`${td} text-center text-muted`}>
                No certificates issued yet.
              </td>
            </tr>
          ) : (
            certificates.map((cert) => (
              <tr key={cert.id} className={trHover}>
                <td className={`${td} font-medium`}>{cert.studentName}</td>
                <td className={td}>{cert.programName}</td>
                <td className={td}>{cert.batchName}</td>
                <td className={`${td} font-mono text-xs`}>{cert.certificateCode}</td>
                <td className={td}>{cert.issuedAt.toLocaleDateString()}</td>
                <td className={td}>
                  <Badge label={cert.status} tone={cert.status === "issued" ? "green" : "slate"} />
                </td>
                <td className={td}>
                  <div className="flex flex-wrap gap-2">
                    <LinkButton href={`/academy/certificates/${cert.id}/print`} variant="secondary" className="px-2.5 py-1 text-xs">
                      View
                    </LinkButton>
                    {cert.status === "issued" && (
                      <>
                        <LinkButton
                          href={`/academy/certificates/${cert.id}/print?autoprint=1`}
                          variant="secondary"
                          className="px-2.5 py-1 text-xs"
                        >
                          Print
                        </LinkButton>
                        <a href={`/academy/certificates/${cert.id}/pdf`} download>
                          <Button type="button" className="px-2.5 py-1 text-xs">
                            Download PDF
                          </Button>
                        </a>
                      </>
                    )}
                  </div>
                </td>
                {canManage && (
                  <td className={td}>
                    {cert.status === "issued" &&
                      (cancellingId === cert.id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="text"
                            placeholder="Cancellation reason"
                            value={cancelReason}
                            onChange={(e) => setCancelReason(e.target.value)}
                            className={`${inputClass} w-48 py-1.5`}
                          />
                          <Button
                            type="button"
                            variant="danger"
                            className="px-2.5 py-1 text-xs"
                            disabled={isPending || cancelReason.trim() === ""}
                            onClick={() => handleCancel(cert.id)}
                          >
                            Confirm cancel
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            className="px-2.5 py-1 text-xs"
                            onClick={() => {
                              setCancellingId(null);
                              setCancelReason("");
                            }}
                          >
                            Back
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="danger"
                          className="px-2.5 py-1 text-xs"
                          disabled={isPending}
                          onClick={() => setCancellingId(cert.id)}
                        >
                          Cancel
                        </Button>
                      ))}
                    {cert.status === "cancelled" && cert.cancellationReason && (
                      <span className="text-xs text-muted">Reason: {cert.cancellationReason}</span>
                    )}
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </TableWrap>

      {canManage && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Issue certificate</h2>
          <p className="mt-1 text-sm text-muted">
            Pick the student and batch (see <Link href="/academy/students" className="text-brand hover:underline">Students</Link>{" "}
            and <Link href="/academy/batches" className="text-brand hover:underline">Batches</Link>). Issuing is blocked unless the
            student has a published, passing result in that batch.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <Field label="Student" className="min-w-[260px]">
              <select value={issueStudentId} onChange={(e) => setIssueStudentId(e.target.value)} className={inputClass}>
                <option value="" disabled>
                  {studentOptions.length === 0 ? "No active students yet" : "Select a student…"}
                </option>
                {studentOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.fullName} ({option.studentNumber})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Batch" className="min-w-[260px]">
              <select value={issueBatchId} onChange={(e) => setIssueBatchId(e.target.value)} className={inputClass}>
                <option value="" disabled>
                  {batchOptions.length === 0 ? "No batches yet" : "Select a batch…"}
                </option>
                {batchOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name} ({option.code})
                  </option>
                ))}
              </select>
            </Field>
            <Button
              type="button"
              disabled={isPending || issueStudentId === "" || issueBatchId === ""}
              onClick={handleIssue}
            >
              {isPending ? "Working..." : "Issue certificate"}
            </Button>
          </div>
          {issueSuccess && <p className="mt-2 text-sm font-medium text-success">{issueSuccess}</p>}
        </Section>
      )}

      <InternalVerificationLookup />
    </div>
  );
}

/** DESIGN.md §9.7 "Certificate Verification (internal lookup)" — same 4
 * fields (student name, program, issue date, status) as the public
 * `/verify/[code]` page, reachable here for staff without leaving the app. */
function InternalVerificationLookup() {
  const [isPending, startTransition] = useTransition();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    studentName: string;
    programName: string;
    issuedAt: Date;
    status: "valid" | "cancelled";
  } | null>(null);

  function handleLookup() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const response = await verifyCertificateInternalAction(code.trim());
      if (!response.ok) {
        setError(response.error.message);
        return;
      }
      setResult(response.certificate);
    });
  }

  return (
    <Section>
      <h2 className="text-base font-semibold text-ink">Verify a certificate</h2>
      <p className="mt-1 text-sm text-muted">Look up any certificate by its printed code — identical to the public verification page.</p>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="Certificate code" className="min-w-[260px]">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="AB3D-7HKL-9MNP-Q2ST"
            className={inputClass}
          />
        </Field>
        <Button type="button" variant="secondary" disabled={isPending || code.trim() === ""} onClick={handleLookup}>
          {isPending ? "Looking up..." : "Verify"}
        </Button>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorMessage message={error} />
        </div>
      )}
      {result && (
        <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted">Student</dt>
            <dd className="text-ink">{result.studentName}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Program</dt>
            <dd className="text-ink">{result.programName}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Issued</dt>
            <dd className="text-ink">{result.issuedAt.toLocaleDateString()}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Status</dt>
            <dd>
              <Badge label={result.status} tone={result.status === "valid" ? "green" : "slate"} />
            </dd>
          </div>
        </dl>
      )}
    </Section>
  );
}
