import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { CertificatePrintData } from "@/lib/academies/certificate-print";

/**
 * Server-only PDF rendering of the same certificate content as
 * app/academy/certificates/[certificateId]/print/certificate-print-view.tsx
 * — a separate rendering engine (@react-pdf/renderer's own Yoga-based
 * flexbox layout, not real HTML/CSS), so this isn't pixel-identical to the
 * print/HTML view, but reproduces the same A4 landscape structure/content:
 * academy branding, title, student name, program/batch, grade, signature
 * area, certificate code, issue date, and the same QR code image pointing
 * at the same verification URL. Only ever imported from the `/pdf` Route
 * Handler (lib/certificates/pdf-document.tsx never ships to the client
 * bundle — @react-pdf/renderer's `renderToBuffer`/`pdf()` are Node APIs).
 */

const styles = StyleSheet.create({
  page: {
    padding: 24,
    fontFamily: "Times-Roman",
    color: "#1B2A4A",
  },
  outerBorder: {
    flex: 1,
    border: "2pt solid #1B2A4A",
    padding: 8,
  },
  innerBorder: {
    flex: 1,
    border: "1pt solid #2F5FE0",
    padding: 24,
    alignItems: "center",
    justifyContent: "space-between",
  },
  logo: { maxWidth: 140, maxHeight: 50, marginBottom: 6, objectFit: "contain" },
  academyName: { fontSize: 14, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", textAlign: "center" },
  title: { fontSize: 26, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase", marginTop: 10, textAlign: "center" },
  lead: { fontSize: 11, color: "#4B5563", marginTop: 14, textAlign: "center" },
  studentName: {
    fontSize: 26,
    fontWeight: 700,
    marginTop: 6,
    paddingBottom: 6,
    borderBottom: "1.5pt solid #2F5FE0",
    textAlign: "center",
  },
  programLine: { fontSize: 13, marginTop: 10, textAlign: "center" },
  batchLine: { fontSize: 10, color: "#4B5563", marginTop: 4, textAlign: "center" },
  gradeLine: { fontSize: 12, fontWeight: 700, marginTop: 6, textAlign: "center" },
  footerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    width: "100%",
    marginTop: 20,
  },
  column: { flex: 1, alignItems: "center" },
  signatureLine: { width: 140, borderTop: "1pt solid #1B2A4A", marginBottom: 4 },
  smallLabel: { fontSize: 8, color: "#6B7280", textTransform: "uppercase", letterSpacing: 1 },
  metaText: { fontSize: 9, color: "#4B5563" },
  certCode: { fontSize: 11, fontWeight: 700, fontFamily: "Courier" },
  qrImage: { width: 60, height: 60, marginBottom: 4 },
  verifyText: { fontSize: 7, color: "#6B7280", maxWidth: 140, textAlign: "center" },
  contact: { fontSize: 8, color: "#6B7280", marginTop: 10, textAlign: "center" },
  cancelledBanner: {
    position: "absolute",
    top: "42%",
    left: "20%",
    fontSize: 40,
    fontWeight: 700,
    letterSpacing: 6,
    color: "#B91C1C",
    opacity: 0.35,
    textTransform: "uppercase",
    transform: "rotate(-18deg)",
  },
});

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

export function CertificatePdfDocument({ data }: { data: CertificatePrintData }) {
  const { certificate, academy, student, program, course, batch, grade, verificationUrl, qrCodeDataUrl } = data;
  const isCancelled = certificate.status === "cancelled";

  return (
    <Document title={`Certificate ${certificate.certificateCode}`}>
      <Page size="A4" orientation="landscape" style={styles.page}>
        <View style={styles.outerBorder}>
          <View style={styles.innerBorder}>
            {isCancelled && <Text style={styles.cancelledBanner}>Cancelled</Text>}

            <View style={{ alignItems: "center" }}>
              {academy.logoRef && (
                // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer's own PDF `Image` primitive, not an HTML <img>; it has no alt prop.
                <Image src={academy.logoRef} style={styles.logo} />
              )}
              <Text style={styles.academyName}>{academy.name}</Text>
              <Text style={styles.title}>Certificate of Completion</Text>
            </View>

            <View style={{ alignItems: "center" }}>
              <Text style={styles.lead}>This is to certify that</Text>
              <Text style={styles.studentName}>{student.fullName}</Text>
              <Text style={styles.lead}>has successfully completed</Text>
              {program && (
                <Text style={styles.programLine}>
                  {program.name}
                  {course && course.name !== program.name ? ` — ${course.name}` : ""}
                </Text>
              )}
              <Text style={styles.batchLine}>
                Batch: {batch.name} ({batch.code})
              </Text>
              {grade && (
                <Text style={styles.gradeLine}>
                  Grade: {grade.gradeLabel} ({grade.marksObtained} marks)
                </Text>
              )}
            </View>

            <View style={styles.footerRow}>
              <View style={styles.column}>
                <View style={styles.signatureLine} />
                <Text style={styles.smallLabel}>Authorized Signature</Text>
              </View>

              <View style={styles.column}>
                <Text style={styles.metaText}>Issued: {formatDate(certificate.issuedAt)}</Text>
                <Text style={styles.certCode}>{certificate.certificateCode}</Text>
              </View>

              <View style={styles.column}>
                {qrCodeDataUrl && (
                  // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer's own PDF `Image` primitive, not an HTML <img>; it has no alt prop.
                  <Image src={qrCodeDataUrl} style={styles.qrImage} />
                )}
                <Text style={styles.verifyText}>{verificationUrl}</Text>
              </View>
            </View>

            {(academy.address || academy.phone || academy.email || academy.website || academy.registrationNumber) && (
              <Text style={styles.contact}>
                {[
                  academy.address,
                  academy.phone,
                  academy.email,
                  academy.website,
                  academy.registrationNumber && `Reg. ${academy.registrationNumber}`,
                ]
                  .filter(Boolean)
                  .join("   •   ")}
              </Text>
            )}
          </View>
        </View>
      </Page>
    </Document>
  );
}
