"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import {
  cancelCertificateAction,
  issueCertificateAction,
  verifyCertificateInternalAction,
} from "@/lib/academies/certificates-actions";
import { Card, EmptyState, ErrorMessage, PrimaryButton, SecondaryButton, StatusBadge } from "@/app/academy/_shell/ui";
import { color, spacing } from "@/lib/ui/theme";

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
}

/**
 * DESIGN.md §9.7. Issue/cancel forms use plain studentId/batchId text
 * inputs rather than a search/autocomplete widget — same documented
 * precedent as app/academy/id-cards/id-card-lookup.tsx ("no student
 * search/autocomplete... this item doesn't depend on it being built").
 * Cancel's reveal-then-confirm pattern mirrors
 * app/academy/results/results-list.tsx's Reject flow exactly (same
 * "require a reason, confirmation before the destructive/terminal action"
 * shape DESIGN.md §3 Modal spec calls for).
 */
export function CertificatesList({ certificates, canManage }: Props) {
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
      const result = await issueCertificateAction(issueStudentId.trim(), issueBatchId.trim());
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
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.xl }}>
      {error && <ErrorMessage message={error} />}

      <Card>
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>All certificates</h2>
        {certificates.length === 0 ? (
          <EmptyState message="No certificates issued yet." />
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: `1px solid ${color.border}` }}>
                  <th style={{ padding: "0.4rem 0" }}>Student</th>
                  <th style={{ padding: "0.4rem 0" }}>Program</th>
                  <th style={{ padding: "0.4rem 0" }}>Batch</th>
                  <th style={{ padding: "0.4rem 0" }}>Code</th>
                  <th style={{ padding: "0.4rem 0" }}>Issued</th>
                  <th style={{ padding: "0.4rem 0" }}>Status</th>
                  {canManage && <th style={{ padding: "0.4rem 0" }}>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {certificates.map((cert) => (
                  <tr key={cert.id} style={{ borderBottom: `1px solid ${color.border}` }}>
                    <td style={{ padding: "0.4rem 0" }}>{cert.studentName}</td>
                    <td style={{ padding: "0.4rem 0" }}>{cert.programName}</td>
                    <td style={{ padding: "0.4rem 0" }}>{cert.batchName}</td>
                    <td style={{ padding: "0.4rem 0", fontFamily: "monospace", fontSize: "0.8rem" }}>
                      {cert.certificateCode}
                    </td>
                    <td style={{ padding: "0.4rem 0" }}>{cert.issuedAt.toLocaleDateString()}</td>
                    <td style={{ padding: "0.4rem 0" }}>
                      <StatusBadge
                        label={cert.status}
                        tone={cert.status === "issued" ? "green" : "slate"}
                      />
                    </td>
                    {canManage && (
                      <td style={{ padding: "0.4rem 0" }}>
                        {cert.status === "issued" &&
                          (cancellingId === cert.id ? (
                            <div style={{ display: "flex", gap: spacing.xs, alignItems: "center" }}>
                              <input
                                type="text"
                                placeholder="Cancellation reason"
                                value={cancelReason}
                                onChange={(e) => setCancelReason(e.target.value)}
                                style={{ width: "12rem" }}
                              />
                              <PrimaryButton
                                type="button"
                                disabled={isPending || cancelReason.trim() === ""}
                                onClick={() => handleCancel(cert.id)}
                              >
                                Confirm cancel
                              </PrimaryButton>
                              <SecondaryButton
                                type="button"
                                onClick={() => {
                                  setCancellingId(null);
                                  setCancelReason("");
                                }}
                              >
                                Back
                              </SecondaryButton>
                            </div>
                          ) : (
                            <SecondaryButton type="button" disabled={isPending} onClick={() => setCancellingId(cert.id)}>
                              Cancel
                            </SecondaryButton>
                          ))}
                        {cert.status === "cancelled" && cert.cancellationReason && (
                          <span style={{ fontSize: "0.75rem", color: color.textMuted }}>
                            Reason: {cert.cancellationReason}
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {canManage && (
        <Card>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Issue certificate</h2>
          <p style={{ fontSize: "0.8rem", color: color.textMuted, marginTop: 0 }}>
            Enter the student and batch id (see <Link href="/academy/students">Students</Link> and{" "}
            <Link href="/academy/batches">Batches</Link>). Issuing is blocked unless the student has a published,
            passing result in that batch.
          </p>
          <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
              Student id
              <input
                type="text"
                value={issueStudentId}
                onChange={(e) => setIssueStudentId(e.target.value)}
                style={{ minWidth: 280 }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
              Batch id
              <input
                type="text"
                value={issueBatchId}
                onChange={(e) => setIssueBatchId(e.target.value)}
                style={{ minWidth: 280 }}
              />
            </label>
            <PrimaryButton
              type="button"
              disabled={isPending || issueStudentId.trim() === "" || issueBatchId.trim() === ""}
              onClick={handleIssue}
            >
              {isPending ? "Working..." : "Issue certificate"}
            </PrimaryButton>
          </div>
          {issueSuccess && <p style={{ color: color.statusGreen, fontSize: "0.85rem" }}>{issueSuccess}</p>}
        </Card>
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
    <Card>
      <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Verify a certificate</h2>
      <p style={{ fontSize: "0.8rem", color: color.textMuted, marginTop: 0 }}>
        Look up any certificate by its printed code — identical to the public verification page.
      </p>
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
          Certificate code
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="AB3D-7HKL-9MNP-Q2ST"
            style={{ minWidth: 260 }}
          />
        </label>
        <PrimaryButton type="button" disabled={isPending || code.trim() === ""} onClick={handleLookup}>
          {isPending ? "Looking up..." : "Verify"}
        </PrimaryButton>
      </div>
      {error && (
        <div style={{ marginTop: spacing.sm }}>
          <ErrorMessage message={error} />
        </div>
      )}
      {result && (
        <dl style={{ marginTop: spacing.sm, fontSize: "0.9rem" }}>
          <dt style={{ color: color.textMuted, fontSize: "0.75rem" }}>Student</dt>
          <dd style={{ margin: "0 0 0.5rem" }}>{result.studentName}</dd>
          <dt style={{ color: color.textMuted, fontSize: "0.75rem" }}>Program</dt>
          <dd style={{ margin: "0 0 0.5rem" }}>{result.programName}</dd>
          <dt style={{ color: color.textMuted, fontSize: "0.75rem" }}>Issued</dt>
          <dd style={{ margin: "0 0 0.5rem" }}>{result.issuedAt.toLocaleDateString()}</dd>
          <dt style={{ color: color.textMuted, fontSize: "0.75rem" }}>Status</dt>
          <dd style={{ margin: 0 }}>
            <StatusBadge label={result.status} tone={result.status === "valid" ? "green" : "slate"} />
          </dd>
        </dl>
      )}
    </Card>
  );
}
