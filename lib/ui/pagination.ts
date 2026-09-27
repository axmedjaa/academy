/**
 * Pure page-number windowing logic for the shared pagination component
 * (components/ui/pagination.tsx + components/pagination-nav.tsx). Kept
 * dependency-free and framework-free so it's trivially unit-testable,
 * matching this codebase's convention for pure UI logic (e.g. lib/ui/status.ts).
 */

export type PaginationItem = number | "ellipsis";

/**
 * Parses a Next.js server-component `searchParams`' `page` value into a
 * valid 1-based page number — every paginated page in this app was
 * previously re-deriving this exact `Number.parseInt(...) || 1` dance
 * locally (app/academy/students, /admissions, /audit-logs,
 * /platform/audit-logs); centralized here since any *new* paginated page
 * needs the identical parsing, not to churn the ones that already had it
 * working inline.
 */
export function parsePageParam(searchParams: Record<string, string | string[] | undefined>): number {
  const value = searchParams.page;
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * Returns the page numbers (plus "ellipsis" markers for collapsed gaps) to
 * render for a given current page out of a total page count — always
 * includes page 1 and the last page, plus one neighbor on each side of the
 * current page, so the control never grows into "an enormous row" (per this
 * feature's own requirement) regardless of how many total pages exist.
 *
 * Returns an empty array for `totalPages <= 1` — the caller should render no
 * pagination controls at all in that case.
 */
export function buildPaginationItems(currentPage: number, totalPages: number): PaginationItem[] {
  if (totalPages <= 1) return [];

  // Small enough to just show every page number — no point collapsing
  // anything (also keeps a 2-page gap, e.g. current=1 of 4, from being
  // misread as "worth an ellipsis" by the anchor logic below).
  const MAX_WITHOUT_COLLAPSING = 7;
  if (totalPages <= MAX_WITHOUT_COLLAPSING) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const clampedCurrent = Math.min(Math.max(currentPage, 1), totalPages);
  const anchors = new Set<number>([1, totalPages]);
  for (let page = clampedCurrent - 1; page <= clampedCurrent + 1; page++) {
    if (page >= 1 && page <= totalPages) {
      anchors.add(page);
    }
  }

  const sorted = Array.from(anchors).sort((a, b) => a - b);
  const items: PaginationItem[] = [];
  let previous: number | null = null;
  for (const page of sorted) {
    if (previous !== null && page - previous > 1) {
      items.push("ellipsis");
    }
    items.push(page);
    previous = page;
  }
  return items;
}
