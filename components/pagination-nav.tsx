import { buildPaginationItems } from "@/lib/ui/pagination";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";

export interface PaginationNavProps {
  page: number;
  pageSize: number;
  totalCount: number;
  /** The page's own resolved `searchParams` (Next's async server-component
   * prop, already awaited by the caller) — every existing filter/search
   * value is preserved on every page link; only `paramName` itself changes. */
  searchParams: Record<string, string | string[] | undefined>;
  /** Query-param key this control reads/writes — defaults to `"page"`,
   * every existing single-list page's own convention. Override when a page
   * paginates more than one independent list at once (e.g.
   * `/academy/finance`'s Charges and Payments tabs each need their own
   * page number, so one uses `"chargesPage"` and the other
   * `"paymentsPage"` — otherwise paging one would silently also move the
   * other). */
  paramName?: string;
  /** Set false when the page already shows its own "Showing X of Y" line. */
  showTotal?: boolean;
}

/** `searchParams` -> a `?query=string`, replacing `paramName` with the
 * given value and dropping any empty-string params (same normalization
 * every consumer of this pattern already did locally, e.g. the old
 * per-page `paramsToRecord`). */
function buildPageHref(
  searchParams: Record<string, string | string[] | undefined>,
  page: number,
  paramName: string,
): string {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === paramName) continue;
    const v = Array.isArray(value) ? value[0] : value;
    if (v) record[key] = v;
  }
  record[paramName] = String(page);
  return `?${new URLSearchParams(record).toString()}`;
}

/**
 * The one shared, server-rendered pagination control for every paginated
 * list page across both consoles — currently `/academy/students`,
 * `/academy/admissions`, `/academy/audit-logs`, and `/platform/audit-logs`:
 * the only pages with real server-side pagination (`page`/`pageSize`/
 * `totalCount` from their own data-access layer; see each page's own
 * comment). Deliberately not scoped under `app/academy/` — it's shared by
 * the Platform Owner console too. Pure presentation: plain `<a href>` links
 * built from the caller's existing `searchParams`, same "GET query param,
 * re-navigate, server-render" convention those pages already used — no
 * client JS, no new fetch, no change to how any page loads its data.
 *
 * Renders nothing at all when there's only one page (or none) — DESIGN.md's
 * "never show a control with nothing useful to do" — matching this
 * feature's own "hide pagination entirely for one page" requirement.
 */
export function PaginationNav({ page, pageSize, totalCount, searchParams, paramName = "page", showTotal = true }: PaginationNavProps) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  if (totalPages <= 1) {
    return null;
  }

  const items = buildPaginationItems(page, totalPages);
  const hasPrevious = page > 1;
  const hasNext = page < totalPages;

  return (
    <nav aria-label="Results pagination" className="mt-4 flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
      {showTotal && <p className="text-sm text-muted">{totalCount} total</p>}
      <Pagination className="mx-0 w-auto justify-end">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious href={hasPrevious ? buildPageHref(searchParams, page - 1, paramName) : undefined} />
          </PaginationItem>
          {items.map((item, index) =>
            item === "ellipsis" ? (
              <PaginationItem key={`ellipsis-${index}`}>
                <PaginationEllipsis />
              </PaginationItem>
            ) : (
              <PaginationItem key={item}>
                <PaginationLink href={buildPageHref(searchParams, item, paramName)} isActive={item === page}>
                  {item}
                </PaginationLink>
              </PaginationItem>
            ),
          )}
          <PaginationItem>
            <PaginationNext href={hasNext ? buildPageHref(searchParams, page + 1, paramName) : undefined} />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </nav>
  );
}
