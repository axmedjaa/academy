"use client";

import { Fragment, useState } from "react";
import type { AuditLogRow } from "@/lib/audit-query";
import { Badge, trHover } from "@/app/academy/_shell/ui";
import { rtTd } from "@/app/academy/_shell/page-blocks";
import { Icon } from "@/app/academy/_shell/icons";

/**
 * Academy audit rows (design A19): When / Who / What happened / Record /
 * Result, each row expandable to its stored before and after values. The
 * Platform audit log keeps its own shared row component.
 */

const WHEN = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Africa/Mogadishu",
});

/** "enrollStudentInBatch" / "student.register" -> "Enroll student in batch". */
export function humanizeAction(action: string): string {
  const words = action
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
}

function initials(label: string): string {
  const name = label.split("@")[0].replace(/[._-]+/g, " ").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function AuditRows({
  rows,
  actorLabels,
  roleLabels,
}: {
  rows: AuditLogRow[];
  actorLabels: Record<string, string>;
  roleLabels: Record<string, string>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <>
      {rows.map((row) => {
        const who = row.actorUserId ? (actorLabels[row.actorUserId] ?? "Unknown person") : "System";
        const hasDetail = row.before !== null || row.after !== null;
        const open = openId === row.id;
        return (
          <Fragment key={row.id}>
            <tr className={trHover}>
              <td className={`${rtTd} whitespace-nowrap tabular-nums`} data-label="When">
                {WHEN.format(row.createdAt)}
              </td>
              <td className={rtTd} data-label="Who">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-tint text-xs font-bold text-brand">
                    {row.actorUserId ? initials(who) : "SY"}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{who}</span>
                    <span className="block text-xs text-muted">
                      {row.actorRole ? (roleLabels[row.actorRole] ?? row.actorRole) : "Not signed in"}
                    </span>
                  </span>
                </span>
              </td>
              <td className={rtTd} data-label="What happened">
                {humanizeAction(row.action)}
              </td>
              <td className={rtTd} data-label="Record">
                {humanizeAction(row.entityType)}
                {row.entityId && <span className="block font-mono text-xs text-muted">{row.entityId.slice(0, 8)}</span>}
              </td>
              <td className={rtTd} data-label="Result">
                <Badge label={row.result === "success" ? "Success" : "Failed"} tone={row.result === "success" ? "green" : "red"} />
              </td>
              <td className={rtTd} data-actions="">
                {hasDetail && (
                  <button
                    type="button"
                    onClick={() => setOpenId(open ? null : row.id)}
                    aria-expanded={open}
                    className="inline-flex h-10 items-center gap-1 rounded-lg px-2.5 text-[13px] font-semibold text-[#374151] hover:bg-app"
                  >
                    {open ? "Hide details" : "Details"}
                    <Icon name="expand_more" width={16} height={16} className={open ? "rotate-180" : ""} />
                  </button>
                )}
              </td>
            </tr>
            {open && hasDetail && (
              <tr>
                <td colSpan={6} className="border-b border-border bg-app/60 p-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {(["before", "after"] as const).map((side) => (
                      <div key={side} className="min-w-0">
                        <div className="mb-1 text-xs font-semibold text-muted">{side === "before" ? "Before" : "After"}</div>
                        <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs whitespace-pre-wrap break-words">
                          {row[side] ? JSON.stringify(row[side], null, 2) : "Nothing recorded"}
                        </pre>
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}
