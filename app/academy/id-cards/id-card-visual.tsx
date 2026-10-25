import type { IdCardRecord } from "@/lib/academies/id-cards";
import { formatDate } from "@/lib/ui/date";

export interface IdCardFaceProps {
  card: IdCardRecord | null;
  studentName: string;
  studentNumber: string;
  /** Batch names the student is actively enrolled in ("Not enrolled" when none). */
  batch: string;
  branch: string;
  academy: { name: string; address: string | null; phone: string | null; logoUrl: string | null };
  /** The student's current profile photo (signed URL, display only). */
  photoUrl: string | null;
  /** Server-rendered QR image (data URL) of the printed card identifier. */
  qrDataUrl: string | null;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

/** Decorative bar pattern derived from the student number, as the design
 * draws it. It is not a scannable barcode, so it is hidden from assistive
 * technology. */
function bars(seed: string) {
  const out: { w: number; on: boolean }[] = [];
  seed.split("").forEach((ch, i) => {
    const v = (ch.charCodeAt(0) * 37 + i * 11) % 32;
    for (let k = 0; k < 5; k++) {
      const wide = (v >> k) & 1;
      out.push({ w: wide ? 2.3 : 1.1, on: true });
      out.push({ w: wide ? 1.1 : 1.9, on: false });
    }
  });
  return out;
}

function LogoTile({ academy, size }: { academy: IdCardFaceProps["academy"]; size: number }) {
  return academy.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- signed storage URL; this codebase renders images with plain <img>
    <img src={academy.logoUrl} alt="" style={{ width: size, height: size }} className="shrink-0 rounded-md bg-white object-contain p-0.5" />
  ) : (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      className="flex shrink-0 items-center justify-center rounded-md bg-white font-bold text-brand"
    >
      {initialsOf(academy.name)}
    </span>
  );
}

const CARD = "relative aspect-[1.586/1] w-full max-w-[340px] overflow-hidden rounded-xl bg-white shadow-[0_4px_16px_rgba(17,24,39,0.16)] ring-1 ring-border";
const LABEL = "block text-[6.5px] font-semibold uppercase tracking-[0.08em] text-muted";

/** ID card front (design A18 `idcard`): academy band, photo, name, student
 * number, batch, branch, bar pattern and issue date. */
export function IdCardFront({ card, studentName, studentNumber, batch, branch, academy, photoUrl }: IdCardFaceProps) {
  return (
    <div className={CARD} role="img" aria-label={`ID card front for ${studentName}, ${studentNumber}`}>
      <div className="flex h-[22%] items-center gap-2.5 bg-brand px-3.5">
        <LogoTile academy={academy} size={28} />
        <div className="min-w-0 leading-tight text-white">
          <div className="truncate text-[11.5px] font-bold">{academy.name}</div>
          <div className="text-[6.5px] font-semibold uppercase tracking-[0.14em] opacity-90">Student identity card</div>
        </div>
      </div>
      <div className="h-[3px] bg-[#F5B638]" />
      <span aria-hidden="true" className="absolute -bottom-[18%] right-[-6%] h-[62%] w-[42%] rounded-full bg-brand-tint" />
      <span aria-hidden="true" className="absolute -bottom-[28%] right-[10%] h-[52%] w-[34%] rounded-full bg-[rgba(245,182,56,0.28)]" />
      <div className="relative flex gap-3 px-3.5 pt-2.5">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
          <img src={photoUrl} alt="" className="h-[78px] w-[64px] shrink-0 rounded-md border-[1.5px] border-brand object-cover" />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-[78px] w-[64px] shrink-0 items-center justify-center rounded-md border-[1.5px] border-brand bg-brand-tint text-[22px] font-bold text-brand"
          >
            {initialsOf(studentName)}
          </span>
        )}
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-[12.5px] font-bold text-ink">{studentName}</div>
          <span className={`${LABEL} mt-1`}>Student no.</span>
          <span className="block font-mono text-[10px] font-semibold text-brand">{studentNumber}</span>
          <span className={`${LABEL} mt-1`}>Batch</span>
          <span className="block truncate text-[9px] font-medium text-ink">{batch}</span>
          <span className={`${LABEL} mt-1`}>Branch</span>
          <span className="block truncate text-[9px] font-medium text-ink">{branch}</span>
        </div>
      </div>
      <div className="absolute inset-x-3.5 bottom-2 flex items-end justify-between gap-3">
        <span aria-hidden="true" className="flex h-[18px] min-w-0 overflow-hidden">
          {bars(studentNumber).map((bar, i) => (
            <span key={i} style={{ width: bar.w }} className={`h-full shrink-0 ${bar.on ? "bg-ink" : ""}`} />
          ))}
        </span>
        <span className="shrink-0 text-right leading-tight">
          <span className="block text-[6.5px] text-muted">Issued</span>
          <span className="block text-[8px] font-semibold text-ink">{card ? formatDate(card.issuedAt) : "Not issued yet"}</span>
        </span>
      </div>
    </div>
  );
}

/** ID card back: academy contact details, the return notice, a signature
 * line and the card number with its QR. */
export function IdCardBack({ card, academy, qrDataUrl }: IdCardFaceProps) {
  return (
    <div className={`${CARD} border-b-[3px] border-[#F5B638]`} role="img" aria-label={`ID card back${card ? `, card ${card.cardNumber}` : ""}`}>
      <div className="mt-[4.5%] h-[11%] bg-ink" />
      <div className="flex items-start gap-2.5 px-3.5 pt-2.5">
        <span className="rounded-md ring-1 ring-border">
          <LogoTile academy={academy} size={30} />
        </span>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[10.5px] font-bold text-brand">{academy.name}</div>
          {academy.address && <div className="truncate text-[7px] text-muted">{academy.address}</div>}
          {academy.phone && <div className="text-[7px] text-muted">{academy.phone}</div>}
        </div>
      </div>
      <p className="px-3.5 pt-2 text-[6.5px] leading-snug text-[#374151]">
        This card is the property of the academy and must be carried on campus. It is not transferable. If found, please return it to the
        academy office.
      </p>
      <div className="absolute inset-x-3.5 bottom-2 flex items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="border-t border-ink" />
          <div className="mt-0.5 text-[5.5px] font-semibold uppercase tracking-[0.08em] text-muted">Authorized signature</div>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-0.5">
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- server-generated data URL
            <img src={qrDataUrl} alt="" className="h-[46px] w-[46px]" />
          ) : (
            <span className="h-[46px] w-[46px] rounded bg-app" />
          )}
          <span className="font-mono text-[6.5px] font-semibold text-ink">{card ? card.cardNumber : "Not issued"}</span>
        </div>
      </div>
    </div>
  );
}

/** Front and back side by side (stacked on phones). `#id-card-printable`
 * is the only thing the print stylesheet keeps. */
export function IdCardPreview(props: IdCardFaceProps) {
  return (
    <div id="id-card-printable" className="mb-6 grid gap-5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),340px))]">
      <IdCardFront {...props} />
      <IdCardBack {...props} />
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #id-card-printable, #id-card-printable * { visibility: visible; }
          #id-card-printable { position: fixed; top: 1.5rem; left: 1.5rem; right: 1.5rem; }
          #id-card-printable [role=img] { box-shadow: none !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
    </div>
  );
}
