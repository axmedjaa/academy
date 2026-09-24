import { createElement } from "react";
import { pdf } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";
import type { CertificatePrintData } from "@/lib/academies/certificate-print";
import { CertificatePdfDocument } from "./pdf-document";

/**
 * Pure unit test — no DB, no auth, no HTTP. Constructs a `CertificatePrintData`
 * object by hand (the exact shape `lib/academies/certificate-print.ts`
 * produces, exercised end-to-end against a real DB in
 * lib/academies/certificates.test.ts) and proves the PDF Route Handler's
 * actual rendering step (`pdf(...).toBuffer()`) produces a real,
 * non-empty PDF file, both with and without the fields that are optional
 * in a real certificate (grade, logo, contact info).
 */
function buildData(overrides: Partial<CertificatePrintData> = {}): CertificatePrintData {
  return {
    certificate: {
      id: "11111111-1111-1111-1111-111111111111",
      academyId: "22222222-2222-2222-2222-222222222222",
      studentId: "33333333-3333-3333-3333-333333333333",
      batchId: "44444444-4444-4444-4444-444444444444",
      certificateCode: "AB3D-7HKL-9MNP-Q2ST",
      issuedAt: new Date("2026-01-15T00:00:00Z"),
      issuedBy: "55555555-5555-5555-5555-555555555555",
      status: "issued",
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null,
      createdAt: new Date("2026-01-15T00:00:00Z"),
    },
    academy: {
      name: "Example Academy",
      logoRef: null,
      address: "123 Main St",
      phone: "+1 555-0100",
      email: "info@example-academy.test",
      website: "https://example-academy.test",
      registrationNumber: "REG-001",
    },
    student: { fullName: "Ada Lovelace", studentNumber: "STD-000001" },
    program: { name: "Diploma in Computer Science" },
    course: { name: "Introduction to Programming" },
    batch: { name: "Batch 3", code: "B-003" },
    grade: { marksObtained: 88, gradeLabel: "A" },
    verificationUrl: "https://app.example.com/verify/AB3D-7HKL-9MNP-Q2ST",
    qrCodeDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ...overrides,
  };
}

async function renderToBuffer(data: CertificatePrintData): Promise<Buffer> {
  const documentElement = createElement(CertificatePdfDocument, { data }) as Parameters<typeof pdf>[0];
  const stream = await pdf(documentElement).toBuffer();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe("CertificatePdfDocument", () => {
  it("renders a real, non-empty PDF for a fully-populated certificate", async () => {
    const buffer = await renderToBuffer(buildData());
    expect(buffer.length).toBeGreaterThan(500);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders without a grade, logo, or contact info (all optional)", async () => {
    const buffer = await renderToBuffer(
      buildData({
        grade: null,
        academy: {
          name: "Bare Academy",
          logoRef: null,
          address: null,
          phone: null,
          email: null,
          website: null,
          registrationNumber: null,
        },
      }),
    );
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a cancelled certificate with the watermark path, without throwing", async () => {
    const buffer = await renderToBuffer(
      buildData({
        certificate: {
          ...buildData().certificate,
          status: "cancelled",
          cancelledAt: new Date("2026-02-01T00:00:00Z"),
          cancelledBy: "55555555-5555-5555-5555-555555555555",
          cancellationReason: "Issued in error",
        },
      }),
    );
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders without a QR code when none is available", async () => {
    const buffer = await renderToBuffer(buildData({ qrCodeDataUrl: null }));
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
