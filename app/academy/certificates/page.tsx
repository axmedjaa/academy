import { redirect } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { batches, courses, programs, students } from "@/lib/db/schema";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listCertificates } from "@/lib/academies/certificates";
import { ErrorMessage } from "@/app/academy/_shell/ui";
import { color, spacing } from "@/lib/ui/theme";
import { CertificatesList, type CertificateRow } from "./certificates-list";

/**
 * DESIGN.md §9.7 — `/academy/certificates`: "Issue form; Cancel action
 * (reason required, confirmation)" plus the internal verification lookup
 * ("read-only detail identical in content to the public page"). Backend is
 * entirely Phase 5's existing lib/academies/certificates.ts
 * (listCertificates/getCertificate/issueCertificate/cancelCertificate) and
 * lib/academies/certificates-actions.ts (issueCertificateAction/
 * cancelCertificateAction/verifyCertificateInternalAction, the last one
 * added alongside this page) — no certificate document/PDF renderer is
 * built here, per DESIGN.md's own spec (see that section's own "identical
 * in content" wording, not "identical in presentation").
 *
 * `listCertificates` returns bare `studentId`/`batchId` — this page
 * enriches those into display names via direct, tenant-scoped reads of the
 * existing `students`/`batches`/`courses`/`programs` tables (the exact same
 * join `verifyCertificate` already performs internally, just done here at
 * the page layer so lib/academies/certificates.ts's audited, tested return
 * shape is never modified for a display-only convenience).
 */
export default async function AcademyCertificatesPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const result = await listCertificates(context);
  if (!result.ok) {
    return (
      <div>
        <h1 style={{ color: color.text }}>Certificates</h1>
        <ErrorMessage message={result.error.message} />
      </div>
    );
  }

  const studentIds = [...new Set(result.certificates.map((c) => c.studentId))];
  const batchIds = [...new Set(result.certificates.map((c) => c.batchId))];

  const [studentRows, batchRows] = await Promise.all([
    studentIds.length
      ? db.select({ id: students.id, fullName: students.fullName }).from(students).where(inArray(students.id, studentIds))
      : Promise.resolve([]),
    batchIds.length
      ? db
          .select({ id: batches.id, batchName: batches.name, programName: programs.name })
          .from(batches)
          .innerJoin(courses, eq(courses.id, batches.courseId))
          .innerJoin(programs, eq(programs.id, courses.programId))
          .where(inArray(batches.id, batchIds))
      : Promise.resolve([]),
  ]);

  const studentNameById = new Map(studentRows.map((row) => [row.id, row.fullName]));
  const batchInfoById = new Map(batchRows.map((row) => [row.id, row]));

  const rows: CertificateRow[] = result.certificates.map((certificate) => ({
    id: certificate.id,
    certificateCode: certificate.certificateCode,
    studentId: certificate.studentId,
    studentName: studentNameById.get(certificate.studentId) ?? certificate.studentId,
    batchId: certificate.batchId,
    batchName: batchInfoById.get(certificate.batchId)?.batchName ?? certificate.batchId,
    programName: batchInfoById.get(certificate.batchId)?.programName ?? "—",
    status: certificate.status,
    issuedAt: certificate.issuedAt,
    cancelledAt: certificate.cancelledAt,
    cancellationReason: certificate.cancellationReason,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.xl }}>
      <div>
        <h1 style={{ margin: 0, color: color.text }}>Certificates</h1>
        <p style={{ margin: 0, marginTop: spacing.xxs, color: color.textMuted }}>
          {result.canManage
            ? "Issue and cancel completion certificates for eligible students."
            : "View certificates issued by this academy."}
        </p>
      </div>
      <CertificatesList certificates={rows} canManage={result.canManage} />
    </div>
  );
}
