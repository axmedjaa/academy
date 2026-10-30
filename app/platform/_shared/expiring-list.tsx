"use client";

import Link from "next/link";
import { useState } from "react";
import type { ExpiringSubscriptionRow } from "@/lib/subscriptions/reports";
import { Badge } from "@/app/academy/_shell/ui";
import { planLabel } from "./status";

/** Dashboard preview rows (design P01 `expiringShown`). */
const PREVIEW_ROWS = 4;
/** Rows per page on the full list (design P09 `expRowsShown`). */
const PAGE_ROWS = 6;

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const PAGER_BUTTON =
  "h-10 rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-app disabled:cursor-not-allowed disabled:opacity-50";

/** Design `dayLbl` and tones: red at 3 days or less (and overdue), amber at 7, blue otherwise. */
export function expiryBadge(days: number): { label: string; tone: "red" | "amber" | "blue" } {
  const label =
    days < 0 ? `${-days} day${days === -1 ? "" : "s"} overdue` : days === 0 ? "Ends today" : `${days} day${days === 1 ? "" : "s"} left`;
  return { label, tone: days <= 3 ? "red" : days <= 7 ? "amber" : "blue" };
}

function Row({ row, linkAcademies }: { row: ExpiringSubscriptionRow; linkAcademies: boolean }) {
  const badge = expiryBadge(row.daysUntilExpiry);
  const overdue = row.daysUntilExpiry < 0;
  const content = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink [overflow-wrap:anywhere]">{row.academyName}</span>
        <span className="block text-xs text-muted [overflow-wrap:anywhere]">
          {planLabel(row.planName)}
          {row.status === "trial" ? " · trial" : ""} · {overdue ? "ended" : "ends"} {DATE.format(row.endsAt)}
          {overdue ? " · in grace period" : ""}
        </span>
      </span>
      <span className="shrink-0">
        <Badge label={badge.label} tone={badge.tone} />
      </span>
    </>
  );
  return (
    <li className="border-t border-border">
      {linkAcademies ? (
        <Link
          href={`/platform/academies/${row.academyId}`}
          className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 !text-ink no-underline transition-colors duration-150 hover:bg-app hover:no-underline"
        >
          {content}
        </Link>
      ) : (
        <div className="flex items-center gap-3 py-2.5">{content}</div>
      )}
    </li>
  );
}

/**
 * Expiring subscriptions, in two sizes that never grow the card past a
 * handful of rows:
 * - `preview` (dashboard, design P01): the four most urgent rows and a
 *   full-width link to the full list.
 * - `paged` (reports, design P09 "Expiring within 30 days"): six rows per
 *   page with Previous / Page X of Y / Next and an exact "Showing" line.
 * `rows` arrive classified and capped by `getExpiringSubscriptions`;
 * `totalCount` is the uncapped total, or null when only a lower bound is known.
 */
export function ExpiringList({
  variant,
  rows,
  totalCount,
  cap,
  linkAcademies,
  emptyMessage,
  viewAllHref,
}: {
  variant: "preview" | "paged";
  rows: ExpiringSubscriptionRow[];
  totalCount: number | null;
  cap: number;
  linkAcademies: boolean;
  emptyMessage: string;
  /** `preview` only: where the full list lives. */
  viewAllHref?: string;
}) {
  const [page, setPage] = useState(1);
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-muted">{emptyMessage}</p>;

  const total = totalCount === null ? `${rows.length}+` : totalCount.toLocaleString("en-US");

  if (variant === "preview") {
    const shown = rows.slice(0, PREVIEW_ROWS);
    const more = (totalCount ?? rows.length) > shown.length;
    return (
      <>
        <ul role="list" className="mt-2">
          {shown.map((row) => (
            <Row key={row.subscriptionId} row={row} linkAcademies={linkAcademies} />
          ))}
        </ul>
        {more && viewAllHref && (
          <Link
            href={viewAllHref}
            className="mt-2 flex min-h-11 w-full items-center justify-center rounded-lg border border-border bg-surface text-[13px] font-semibold !text-brand no-underline transition-colors duration-150 hover:bg-brand-tint hover:no-underline"
          >
            View all {total}
          </Link>
        )}
      </>
    );
  }

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_ROWS));
  const current = Math.min(page, pages);
  const first = (current - 1) * PAGE_ROWS;
  const shown = rows.slice(first, first + PAGE_ROWS);
  const capped = totalCount === null || totalCount > rows.length;

  return (
    <>
      <ul role="list" className="mt-2" aria-live="polite">
        {shown.map((row) => (
          <Row key={row.subscriptionId} row={row} linkAcademies={linkAcademies} />
        ))}
      </ul>
      {pages > 1 && (
        <nav aria-label="Expiring subscriptions pages" className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
          <button type="button" className={PAGER_BUTTON} onClick={() => setPage(current - 1)} disabled={current <= 1} aria-label="Previous page">
            Previous
          </button>
          <span className="text-center text-[13px] text-[#374151]">
            Page {current} of {pages}
          </span>
          <button type="button" className={PAGER_BUTTON} onClick={() => setPage(current + 1)} disabled={current >= pages} aria-label="Next page">
            Next
          </button>
        </nav>
      )}
      <p className="mt-2 text-xs text-muted">
        Showing {first + 1}–{first + shown.length} of {capped ? `the ${rows.length} soonest (${total} in total)` : total}.
        {capped ? ` The list is capped at ${cap}.` : ""}
      </p>
    </>
  );
}
