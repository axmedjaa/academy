"use client";

import { useState } from "react";
import type { AuditLogRow as AuditLogRowData } from "@/lib/audit-query";
import { Badge, td, trHover } from "./ui";
import { Icon } from "./icons";

/**
 * Claude Design reference (HANDOFF.md's confirmed-authoritative
 * `Platform Console.dc.html`, the `isAudit` block): an expand/collapse
 * chevron per row revealing a before/after JSON panel — a real,
 * already-documented gap (this project's own discrepancy ledger: "No row
 * expand, no before/after display... despite before/after JSON existing
 * on every row in the schema", and DESIGN.md §3's own claim the platform
 * and academy audit logs share "an identical component", which wasn't
 * true until now). `row.before`/`row.after` are already fetched by each
 * page's own unfiltered `.select()` — no new query, this is presentation
 * only. Shared here (not duplicated per console) so both logs genuinely
 * use the same row component, not just the same visual intent. Client
 * component only for the per-row open/closed toggle; the actual data
 * stays server-fetched.
 */
export function AuditLogTableRow({
  row,
  actorLabel,
}: {
  row: AuditLogRowData;
  actorLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = row.before !== null || row.after !== null;

  return (
    <>
      <tr className={trHover}>
        <td className={`${td} w-9`}>
          {hasDetail && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-label={open ? "Collapse details" : "Expand details"}
              className={`flex h-8 w-8 items-center justify-center rounded-control text-muted transition-transform duration-150 hover:bg-app hover:text-ink ${
                open ? "rotate-180" : ""
              }`}
            >
              <Icon name="expand_more" width={18} height={18} />
            </button>
          )}
        </td>
        <td className={`${td} whitespace-nowrap`}>{row.createdAt.toISOString()}</td>
        <td className={td}>
          {actorLabel}
          {row.actorRole && <span className="text-muted"> ({row.actorRole})</span>}
        </td>
        <td className={td}>{row.action}</td>
        <td className={td}>{row.entityType}</td>
        <td className={td}>
          <Badge label={row.result} tone={row.result === "success" ? "green" : "red"} />
        </td>
      </tr>
      {open && hasDetail && (
        <tr>
          <td colSpan={6} className="border-b border-border bg-app/60 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-semibold text-muted">Before</div>
                <pre className="overflow-auto rounded-control border border-border bg-surface p-3 font-mono text-xs whitespace-pre-wrap break-words">
                  {row.before ? JSON.stringify(row.before, null, 2) : "—"}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold text-muted">After</div>
                <pre className="overflow-auto rounded-control border border-border bg-brand-tint p-3 font-mono text-xs whitespace-pre-wrap break-words">
                  {row.after ? JSON.stringify(row.after, null, 2) : "—"}
                </pre>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
