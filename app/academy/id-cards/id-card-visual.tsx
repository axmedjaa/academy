"use client";

import { color, radius } from "@/lib/ui/theme";
import { PrimaryButton } from "@/app/academy/_shell/ui";
import type { IdCardRecord } from "@/lib/academies/id-cards";

interface Props {
  card: IdCardRecord;
  studentName: string;
  academyName: string;
}

/**
 * DESIGN.md §9.7 `/academy/id-cards`: "Visual card layout matching real
 * ID-card proportions (photo, name, ID, branding, issue/expiry);
 * Generate/Print/Reprint actions; reprint-count/history note." This is the
 * card itself — a fixed-aspect-ratio (CR80, ~1.586:1, the standard
 * physical ID-card proportion) panel with the academy name as branding,
 * the student's photo (or an initials placeholder — no file-storage system
 * exists in this codebase, confirmed by grep before this file was added, so
 * `photoFileRef` is treated as a plain externally-hosted image URL rather
 * than an upload), name, card number, and issue date.
 *
 * No expiry date is rendered: `lib/academies/id-cards.ts`'s `IdCardRecord`
 * (and the underlying `student_id_cards` table) has no expiry column at
 * all — DESIGN.md's "issue/expiry" wording is not backed by the existing
 * schema, and per this task's explicit instruction not to add a migration
 * without proving the gap, this is a documented, deliberate omission rather
 * than an invented value.
 *
 * Printing uses the browser's native `window.print()` plus a scoped
 * `@media print` rule (below) that hides everything except the card itself
 * — no PDF library, per this task's explicit constraint.
 */
export function IdCardVisual({ card, studentName, academyName }: Props) {
  const initials = studentName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  return (
    <div>
      <div
        id="id-card-printable"
        style={{
          width: "340px",
          maxWidth: "100%",
          aspectRatio: "1.586 / 1",
          borderRadius: radius.card,
          border: `1px solid ${color.border}`,
          background: `linear-gradient(135deg, ${color.primaryNavy} 0%, ${color.primaryBlue} 100%)`,
          color: "#fff",
          padding: "1rem",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          boxShadow: "0 4px 16px rgba(15, 23, 42, 0.18)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 700, fontSize: "0.85rem", letterSpacing: "0.02em" }}>{academyName}</span>
          <span style={{ fontSize: "0.65rem", opacity: 0.85, textTransform: "uppercase" }}>Student ID</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.85rem" }}>
          {card.photoFileRef ? (
            // eslint-disable-next-line @next/next/no-img-element -- externally-hosted URL, not a Next-optimizable local asset.
            <img
              src={card.photoFileRef}
              alt={`${studentName}'s photo`}
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                objectFit: "cover",
                border: "2px solid rgba(255,255,255,0.7)",
              }}
            />
          ) : (
            <div
              aria-hidden="true"
              style={{
                width: 56,
                height: 56,
                borderRadius: "50%",
                backgroundColor: "rgba(255,255,255,0.2)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: "1.1rem",
                border: "2px solid rgba(255,255,255,0.7)",
              }}
            >
              {initials || "?"}
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: "1.05rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {studentName}
            </div>
            <div style={{ fontSize: "0.75rem", opacity: 0.85 }}>Status: {card.status}</div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.7rem", opacity: 0.9 }}>
          <span style={{ fontFamily: "monospace" }}>{card.cardNumber}</span>
          <span>Issued {new Date(card.issuedAt).toLocaleDateString()}</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.75rem" }} className="id-card-actions">
        <PrimaryButton type="button" onClick={() => window.print()}>
          Print
        </PrimaryButton>
        {card.reprintCount > 0 && (
          <span style={{ fontSize: "0.75rem", color: color.textMuted }}>Reprinted {card.reprintCount}×</span>
        )}
      </div>

      <style>{`
        @media print {
          body * { visibility: hidden; }
          #id-card-printable, #id-card-printable * { visibility: visible; }
          #id-card-printable {
            position: fixed;
            top: 2rem;
            left: 50%;
            transform: translateX(-50%);
            box-shadow: none !important;
          }
        }
      `}</style>
    </div>
  );
}
