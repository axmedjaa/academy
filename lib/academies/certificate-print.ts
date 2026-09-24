import { and, eq } from "drizzle-orm";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { academies, batches, courses, examResults, gradeBands, programs, students } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { evaluateGradeBand } from "@/lib/academies/results";
import { getCertificate, type CertificateActionError, type CertificateRecord } from "@/lib/academies/certificates";
import type { AuthContext } from "@/lib/auth/auth-context";

/**
 * Authenticated certificate print/PDF view — a NEW, additive read layer on
 * top of the existing, unmodified `lib/academies/certificates.ts`. Every
 * field here is either read straight off the already-tenant-scoped
 * `certificate` row `getCertificate` returns, or resolved from ids on that
 * row (studentId/batchId/academyId) — never from anything client-supplied.
 *
 * ---------------------------------------------------------------------
 * Tenant isolation — the whole security story lives in one reused call
 * ---------------------------------------------------------------------
 * `getCertificate(actorContext, certificateId)` (unchanged) resolves
 * `academyId` from `actorContext` alone (via `checkAcademyAccessForContext`,
 * itself keyed off the session) and filters
 * `eq(certificates.academyId, academyId)` — a certificateId belonging to a
 * different academy already returns the identical generic `not_found` any
 * nonexistent id would. This module never re-derives or trusts an academyId
 * from anywhere else, so it inherits that guarantee automatically rather
 * than re-implementing it.
 *
 * ---------------------------------------------------------------------
 * Grade info is display-only — eligibility logic is untouched
 * ---------------------------------------------------------------------
 * `getCertificateGradeInfo` below duplicates (deliberately, not shared)
 * `isStudentEligibleForCertificate`'s own published-result/grade-band
 * lookup in `certificates.ts` — that function is never imported, modified,
 * or reused here, so the "published, passing result required to issue"
 * rule it enforces cannot be affected by anything in this file. This
 * function only decides what to *print* on an already-issued certificate,
 * never whether one may be issued.
 */

export interface CertificatePrintData {
  certificate: CertificateRecord;
  academy: {
    name: string;
    logoRef: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    registrationNumber: string | null;
  };
  student: { fullName: string; studentNumber: string };
  program: { name: string } | null;
  course: { name: string } | null;
  batch: { name: string; code: string };
  grade: { marksObtained: number; gradeLabel: string } | null;
  verificationUrl: string;
  qrCodeDataUrl: string | null;
}

export type GetCertificatePrintDataResult =
  | { ok: true; data: CertificatePrintData }
  | { ok: false; error: CertificateActionError };

async function getCertificateGradeInfo(
  academyId: string,
  studentId: string,
  batchId: string,
): Promise<{ marksObtained: number; gradeLabel: string } | null> {
  const rows = await db
    .select({ marksObtained: examResults.marksObtained, gradeConfigurationId: examResults.gradeConfigurationId })
    .from(examResults)
    .where(
      and(
        eq(examResults.academyId, academyId),
        eq(examResults.studentId, studentId),
        eq(examResults.batchId, batchId),
        eq(examResults.status, "published"),
      ),
    );

  let best: { marksObtained: number; gradeLabel: string } | null = null;
  const bandsByConfig = new Map<string, { label: string; minMark: number; maxMark: number; isPass: boolean }[]>();

  for (const row of rows) {
    if (row.marksObtained === null) continue;

    let bands = bandsByConfig.get(row.gradeConfigurationId);
    if (!bands) {
      const bandRows = await db.select().from(gradeBands).where(eq(gradeBands.gradeConfigurationId, row.gradeConfigurationId));
      bands = bandRows.map((band) => ({
        label: band.label,
        minMark: Number(band.minMark),
        maxMark: Number(band.maxMark),
        isPass: band.isPass,
      }));
      bandsByConfig.set(row.gradeConfigurationId, bands);
    }

    const marks = Number(row.marksObtained);
    const band = evaluateGradeBand(marks, bands);
    if (band?.isPass && (!best || marks > best.marksObtained)) {
      best = { marksObtained: marks, gradeLabel: band.label };
    }
  }

  return best;
}

/**
 * Builds an absolute `/verify/[certificateCode]` URL — a QR code embedded
 * in a printed/PDF document is scanned from a different device, so a
 * relative path would never resolve. Prefers `APP_URL` (lib/env.ts, same
 * var the email flows already rely on); `requestOrigin` (the caller's own
 * `x-forwarded-proto`/`host` reading, same convention as
 * lib/auth/actions.ts's `getClientIp`) is the fallback for a dev setup that
 * hasn't configured it yet.
 */
export function buildVerificationUrl(certificateCode: string, requestOrigin?: string): string {
  const base = env.APP_URL?.replace(/\/$/, "") ?? requestOrigin?.replace(/\/$/, "") ?? "";
  return `${base}/verify/${encodeURIComponent(certificateCode)}`;
}

export async function getCertificatePrintData(
  actorContext: AuthContext,
  certificateId: string,
  requestOrigin?: string,
): Promise<GetCertificatePrintDataResult> {
  const result = await getCertificate(actorContext, certificateId);
  if (!result.ok) return result;
  const certificate = result.certificate;

  const [academyRow] = await db
    .select({
      name: academies.name,
      logoRef: academies.logoRef,
      address: academies.address,
      phone: academies.phone,
      email: academies.email,
      website: academies.website,
      registrationNumber: academies.registrationNumber,
    })
    .from(academies)
    .where(eq(academies.id, certificate.academyId))
    .limit(1);

  const [studentRow] = await db
    .select({ fullName: students.fullName, studentNumber: students.studentNumber })
    .from(students)
    .where(eq(students.id, certificate.studentId))
    .limit(1);

  const [batchRow] = await db
    .select({
      name: batches.name,
      code: batches.code,
      courseName: courses.name,
      programName: programs.name,
    })
    .from(batches)
    .innerJoin(courses, eq(courses.id, batches.courseId))
    .innerJoin(programs, eq(programs.id, courses.programId))
    .where(eq(batches.id, certificate.batchId))
    .limit(1);

  const grade = await getCertificateGradeInfo(certificate.academyId, certificate.studentId, certificate.batchId);

  const verificationUrl = buildVerificationUrl(certificate.certificateCode, requestOrigin);
  // A QR code is only meaningful with an absolute URL a different device can
  // resolve — never generated against a bare relative path.
  const qrCodeDataUrl = /^https?:\/\//.test(verificationUrl)
    ? await QRCode.toDataURL(verificationUrl, { margin: 1, width: 240 })
    : null;

  return {
    ok: true,
    data: {
      certificate,
      academy: {
        name: academyRow?.name ?? "Academy",
        logoRef: academyRow?.logoRef ?? null,
        address: academyRow?.address ?? null,
        phone: academyRow?.phone ?? null,
        email: academyRow?.email ?? null,
        website: academyRow?.website ?? null,
        registrationNumber: academyRow?.registrationNumber ?? null,
      },
      student: { fullName: studentRow?.fullName ?? "Unknown student", studentNumber: studentRow?.studentNumber ?? "" },
      program: batchRow ? { name: batchRow.programName } : null,
      course: batchRow ? { name: batchRow.courseName } : null,
      batch: { name: batchRow?.name ?? "Unknown batch", code: batchRow?.code ?? "" },
      grade,
      verificationUrl,
      qrCodeDataUrl,
    },
  };
}
