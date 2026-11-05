import Link from "next/link";
import { redirect } from "next/navigation";
import { CAMPAIGN_STATUSES, CAMPAIGN_STATUS_LABEL, type CampaignStatus } from "@/lib/academies/book-preorder-math";
import type { CampaignView } from "@/lib/academies/book-preorders";
import { PageMessage } from "@/app/academy/_shell/ui";
import { FilterSelect, SearchField } from "@/app/academy/_shell/filter-controls";
import { getBooksOverview } from "../../books-data";
import { CampaignButtons, GatedAction, ToneBadge } from "../../books-sections";
import { BTN_SECONDARY, EmptyCard, Pager, SectionHead, paginate, readParams } from "../../books-ui";
import { campaignBadge, plural, shortIsoDate, formatIsoDate } from "../../books-view";

const PAGE_SIZE = 6;
const DAY = 86400000;

function days(n: number) {
  return plural(n, "day", "days");
}

/** Window note and progress, as the design's campaign card shows them. */
function windowOf(c: CampaignView, todayMs: number) {
  const opens = Date.parse(`${c.opensOn}T00:00:00Z`);
  const closes = Date.parse(`${c.closesOn}T00:00:00Z`);
  const left = Math.round((closes - todayMs) / DAY);
  const toOpen = Math.round((opens - todayMs) / DAY);
  const note: Record<CampaignStatus, string> = {
    open: left >= 0 ? `Closes in ${days(left)}` : "Past closing date",
    scheduled: `Opens in ${days(Math.max(toOpen, 0))}`,
    draft: "Not published yet",
    cancelled: "Cancelled",
    closed: `Closed ${days(Math.max(-left, 0))} ago`,
    receiving: `Closed ${days(Math.max(-left, 0))} ago`,
    completed: `Closed ${days(Math.max(-left, 0))} ago`,
  };
  const span = Math.max(closes - opens, DAY);
  const elapsed = Math.min(Math.max((todayMs - opens) / span, 0), 1);
  const pct = c.status === "draft" || c.status === "scheduled" ? 0 : c.status === "open" ? elapsed : 1;
  return { note: note[c.status], pct: Math.round(pct * 100) };
}

/**
 * Pre-Orders (design B02, step 2): campaigns decide which books students
 * can order right now, with optional per-book limits, the order window,
 * expected arrival and the copies students have requested so far.
 */
export default async function PreOrderCampaignsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { booksResult, preordersResult } = overview;
  if (!preordersResult.ok) {
    return <PageMessage title={preordersResult.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={preordersResult.error.message} />;
  }
  const params = await searchParams;
  const { get, page } = readParams(params);
  const q = get("q").toLowerCase();
  const status = get("status");
  const bookName = new Map((booksResult.ok ? booksResult.books : []).map((b) => [b.id, b.name]));
  const todayMs = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);

  const all = preordersResult.overview.campaigns;
  // Design order: open first, then scheduled, receiving, closed, draft,
  // completed, cancelled; newest opening date first within a status.
  const PRIORITY: Record<string, number> = { open: 0, scheduled: 1, receiving: 2, closed: 3, draft: 4, completed: 5, cancelled: 6 };
  const rows = all
    .filter((c) => (!status || c.status === status) && (!q || c.name.toLowerCase().includes(q)))
    .sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status] || b.opensOn.localeCompare(a.opensOn));
  const visible = paginate(rows, page, PAGE_SIZE);

  return (
    <>
      <SectionHead title="Pre-order campaigns" description="Campaigns decide which books students can order right now. Staff can optionally limit copies per book." />
      {all.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 [&>select]:min-w-[150px] [&>select]:flex-[1_1_150px] sm:[&>select]:max-w-none">
          <SearchField placeholder="Search campaigns" />
          <FilterSelect
            param="status"
            label="Status"
            options={[{ value: "", label: "All statuses" }, ...CAMPAIGN_STATUSES.map((s) => ({ value: s, label: CAMPAIGN_STATUS_LABEL[s] }))]}
          />
        </div>
      )}

      {visible.length === 0 ? (
        all.length === 0 ? (
          <EmptyCard
            title="No campaigns yet"
            description="Create a campaign to let students order books that have not arrived yet."
            action={
              <GatedAction need="canManageCampaigns" dialog={{ kind: "campaign" }} variant="secondary">
                Create campaign
              </GatedAction>
            }
          />
        ) : (
          <EmptyCard
            title="No campaigns match"
            description="Try a different search or status."
            action={
              <Link href="/academy/books/pre-orders" className={BTN_SECONDARY}>
                Clear filters
              </Link>
            }
          />
        )
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[repeat(auto-fill,minmax(min(100%,420px),1fr))]">
          {visible.map((c) => {
            const w = windowOf(c, todayMs);
            const copies = c.books.reduce((sum, b) => sum + b.ordered, 0);
            const ranked = [...c.books].sort((a, b) => b.ordered - a.ordered);
            const max = Math.max(1, ...ranked.map((b) => b.ordered));
            return (
              <article key={c.id} className="flex min-w-0 flex-col gap-4 rounded-2xl border border-border bg-surface p-5 shadow-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-base font-bold leading-snug [overflow-wrap:anywhere]">{c.name}</h3>
                    <p className="mt-0.5 text-[13px] text-muted">{plural(c.books.length, "book", "books")}</p>
                  </div>
                  <ToneBadge badge={campaignBadge(c.status)} />
                </div>
                <div>
                  <div className="mb-1.5 flex justify-between gap-2 text-xs text-muted">
                    <span>Opens {shortIsoDate(c.opensOn)}</span>
                    <span>Closes {shortIsoDate(c.closesOn)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded bg-[#F1F2F5]">
                    <div className={`h-full rounded ${c.status === "open" ? "bg-brand" : "bg-border-strong"}`} style={{ width: `${w.pct}%` }} />
                  </div>
                  <p className="mt-1.5 text-[13px] font-semibold">{w.note}</p>
                </div>
                <div className="grid grid-cols-3 gap-3 border-y border-border py-3">
                  <div className="min-w-0">
                    <div className="text-xs text-muted">Orders</div>
                    <div className="mt-0.5 text-[15px] font-bold tabular-nums">{c.orderCount}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs text-muted">Copies ordered</div>
                    <div className="mt-0.5 text-[15px] font-bold tabular-nums">{copies}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs text-muted">Expected arrival</div>
                    <div className="mt-0.5 text-[15px] font-bold tabular-nums">{formatIsoDate(c.expectedArrivalOn)}</div>
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs font-semibold text-[#374151]">Demand by book</p>
                  {ranked.slice(0, 3).map((b) => {
                    const atLimit = b.quantityLimit !== null && b.ordered >= b.quantityLimit;
                    return (
                      <div key={b.bookId} className="mb-2.5">
                        <div className="flex justify-between gap-2 text-[13px]">
                          <span className="min-w-0 truncate">{bookName.get(b.bookId) ?? "Book"}</span>
                          <span className="shrink-0 font-semibold tabular-nums">{b.quantityLimit !== null ? `${b.ordered} of ${b.quantityLimit}` : `${b.ordered} ordered`}</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-sm bg-[#F1F2F5]">
                          <div
                            className={`h-full ${atLimit ? "bg-[#B45309]" : "bg-brand"}`}
                            style={{ width: `${Math.round((b.ordered / (b.quantityLimit ?? max)) * 100)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                  {ranked.length > 3 && <p className="text-xs text-muted">+{ranked.length - 3} more books</p>}
                </div>
                <CampaignButtons campaignId={c.id} status={c.status} name={c.name} />
              </article>
            );
          })}
        </div>
      )}
      <div className="mt-4">
        <Pager page={page} pageSize={PAGE_SIZE} total={rows.length} params={params} />
      </div>
    </>
  );
}
