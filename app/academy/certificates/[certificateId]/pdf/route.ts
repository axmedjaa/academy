import { createElement } from "react";
import { headers } from "next/headers";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getCertificatePrintData } from "@/lib/academies/certificate-print";
import { CertificatePdfDocument } from "@/lib/certificates/pdf-document";
import { logger } from "@/lib/logger";

/**
 * `GET /academy/certificates/[certificateId]/pdf` — serves the certificate
 * as a real `application/pdf` download (`@react-pdf/renderer`, server-side
 * only; see lib/certificates/pdf-document.tsx's own comment).
 *
 * Every authorization/tenant-isolation guarantee here comes from reusing
 * `getCertificatePrintData` unchanged — same as the print page, this route
 * takes only `certificateId` from the URL and resolves the academy from the
 * signed-in session, never from anything client-supplied. A cross-academy
 * or nonexistent id both get the same plain-text `not_found` response, and
 * a cancelled certificate refuses the download outright (same "don't let a
 * cancelled certificate be presented as a valid document" reasoning as the
 * print page's disabled Download button — enforced here too, not just
 * hidden client-side, since this URL is directly reachable).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ certificateId: string }> },
): Promise<Response> {
  const { certificateId } = await params;
  const context = await getAuthContext();
  if (!context) {
    return new Response("You must be signed in.", { status: 401 });
  }

  const headerList = await headers();
  const protocol = headerList.get("x-forwarded-proto") ?? "http";
  const host = headerList.get("host");
  const requestOrigin = host ? `${protocol}://${host}` : undefined;

  const result = await getCertificatePrintData(context, certificateId, requestOrigin);
  if (!result.ok) {
    const status = result.error.code === "forbidden" ? 403 : result.error.code === "blocked" ? 403 : 404;
    return new Response(result.error.message, { status });
  }

  if (result.data.certificate.status === "cancelled") {
    return new Response("This certificate has been cancelled and cannot be downloaded as a PDF.", { status: 409 });
  }

  try {
    const { pdf } = await import("@react-pdf/renderer");
    // @react-pdf/renderer's own .d.ts types `pdf()` as accepting a literal
    // `<Document>` element, not a custom component that renders one — a
    // known typing gap for this library (its own examples pass a wrapper
    // component the same way). The cast is narrow: `pdf`'s actual runtime
    // behavior only ever walks the rendered element tree, which
    // CertificatePdfDocument's single <Document> root satisfies.
    const documentElement = createElement(CertificatePdfDocument, { data: result.data }) as Parameters<typeof pdf>[0];
    const stream = await pdf(documentElement).toBuffer();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="certificate-${result.data.certificate.certificateCode}.pdf"`,
        "Content-Length": String(buffer.length),
      },
    });
  } catch (err) {
    logger.error("certificate pdf generation failed", {
      certificateId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response("Failed to generate the certificate PDF. Please try again.", { status: 500 });
  }
}
