"use client";

import { useEffect } from "react";
import type { CertificatePrintData } from "@/lib/academies/certificate-print";
import { Button, LinkButton } from "@/app/academy/_shell/ui";
import styles from "./certificate-print.module.css";

interface Props {
  certificateId: string;
  data: CertificatePrintData;
  /** From the list's own "Print" link (`?autoprint=1`, read server-side by
   * page.tsx) — fires window.print() once on load so "Print" is genuinely
   * one click from the list, without needing a client-side
   * useSearchParams()/Suspense boundary for a single boolean flag. */
  autoPrint: boolean;
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

/**
 * `window.print()` opens the browser's own print dialog (the task's
 * explicit "Print Certificate" spec) — every OS/browser's print dialog
 * already offers "Save as PDF" as a destination, but "Download PDF" below
 * is still a distinct, direct path per the task brief: a plain `<a
 * download>` to the `/pdf` Route Handler, which serves a real
 * `application/pdf` response server-rendered via @react-pdf/renderer (see
 * that route's own comment) — no client-side PDF library, no extra
 * round-trip/JS needed for the download itself.
 *
 * A cancelled certificate is never hidden (same "stays permanently,
 * distinctly visible" rule the public /verify/[code] page already applies)
 * — it renders with a diagonal "CANCELLED" watermark and disables Print/
 * Download, since printing/downloading a cancelled certificate as if it
 * were a valid, presentable document would be misleading.
 */
export function CertificatePrintView({ certificateId, data, autoPrint }: Props) {
  const { certificate, academy, student, program, batch, grade, verificationUrl, qrCodeDataUrl } = data;
  const isCancelled = certificate.status === "cancelled";

  useEffect(() => {
    if (autoPrint && !isCancelled) {
      window.print();
    }
    // Only ever fires once, on mount — deliberately not re-running if
    // `isCancelled` could somehow change client-side (it can't; this is
    // server-rendered data for one request).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={styles.page}>
      <div className={`${styles.actions} ${styles.noPrint}`}>
        <LinkButton href="/academy/certificates" variant="secondary">
          ← Back to certificates
        </LinkButton>
        <div className="flex-1" />
        <Button type="button" variant="secondary" disabled={isCancelled} onClick={() => window.print()}>
          Print Certificate
        </Button>
        {isCancelled ? (
          <Button type="button" disabled>
            Download PDF
          </Button>
        ) : (
          <a href={`/academy/certificates/${certificateId}/pdf`} download>
            <Button type="button">Download PDF</Button>
          </a>
        )}
      </div>

      {isCancelled && (
        <p className={`${styles.noPrint} text-sm text-danger`} style={{ maxWidth: "297mm", width: "100%" }}>
          This certificate was cancelled{certificate.cancelledAt ? ` on ${formatDate(certificate.cancelledAt)}` : ""}
          {certificate.cancellationReason ? `: ${certificate.cancellationReason}` : "."} Printing and PDF export are
          disabled for cancelled certificates.
        </p>
      )}

      <div className={styles.sheetWrap}>
        <div className={styles.sheet}>
          <div className={styles.borderOuter} />
          <div className={styles.borderInner} />
          {isCancelled && <div className={styles.cancelledBanner}>Cancelled</div>}

          <div className={styles.content}>
            <div className={styles.header}>
              {academy.logoRef && (
                // eslint-disable-next-line @next/next/no-img-element -- externally-hosted URL, same convention as every other logoRef/photoFileRef render in this codebase.
                <img src={academy.logoRef} alt={academy.name} className={styles.logo} />
              )}
              <div className={styles.academyName}>{academy.name}</div>
              <div className={styles.title}>Certificate of Completion</div>
            </div>

            <div className={styles.body}>
              <p className={styles.lead}>This is to certify that</p>
              <p className={styles.studentName}>{student.fullName}</p>
              <p className={styles.lead}>has successfully completed</p>
              {program && (
                <p className={styles.programLine}>
                  <span className={styles.programName}>{program.name}</span>
                  {data.course && data.course.name !== program.name ? ` — ${data.course.name}` : ""}
                </p>
              )}
              <p className={styles.batchLine}>
                Batch: {batch.name} ({batch.code})
              </p>
              {grade && (
                <p className={styles.gradeLine}>
                  Grade: {grade.gradeLabel} ({grade.marksObtained} marks)
                </p>
              )}
            </div>

            <div className={styles.footer}>
              <div className={styles.signatureBlock}>
                <div className={styles.signatureLine} />
                <span className={styles.signatureLabel}>Authorized Signature</span>
              </div>

              <div className={styles.metaBlock}>
                <span>Issued: {formatDate(certificate.issuedAt)}</span>
                <span className={styles.certCode}>{certificate.certificateCode}</span>
              </div>

              <div className={styles.qrBlock}>
                {qrCodeDataUrl && (
                  // eslint-disable-next-line @next/next/no-img-element -- a generated data: URI, not an optimizable remote image.
                  <img src={qrCodeDataUrl} alt="Scan to verify" className={styles.qrImage} />
                )}
                <span className={styles.verifyText}>{verificationUrl}</span>
              </div>
            </div>

            {(academy.address || academy.phone || academy.email || academy.website || academy.registrationNumber) && (
              <p className={styles.academyContact}>
                {[academy.address, academy.phone, academy.email, academy.website, academy.registrationNumber && `Reg. ${academy.registrationNumber}`]
                  .filter(Boolean)
                  .join("  •  ")}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
