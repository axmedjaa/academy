import Link from "next/link";
import { redirect } from "next/navigation";
import { CAMPAIGN_STATUS_LABEL } from "@/lib/academies/book-preorder-math";
import { PageMessage } from "@/app/academy/_shell/ui";
import { FilterSelect } from "@/app/academy/_shell/filter-controls";
import { getBooksOverview } from "../../books-data";
import { SubjectTile } from "../../books-actions";
import { GatedAction, ReceiveButton, ToneBadge } from "../../books-sections";
import { CARD, EmptyCard, InfoNote, KpiGrid, Pager, SectionHead, paginate, readParams } from "../../books-ui";
import { formatIsoDate, percent } from "../../books-view";

const PAGE_SIZE = 6;

/**
 * Receive Books (design B07, step 4): deliveries from the supplier per
 * campaign — quantity received, damaged copies, and what is still to
 * arrive. Usable copies (received minus damaged) form the campaign's pool
 * for giving books to students; ordinary sale stock does not change.
 * Several deliveries per book are allowed.
 */
export default async function ReceiveBooksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { booksResult, preordersResult } = overview;
  if (!preordersResult.ok) {
    return <PageMessage title={preordersResult.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={preordersResult.error.message} />;
  }
  const params = await searchParams;
  const { get, page } = readParams(params);
  const { campaigns, receipts } = preordersResult.overview;
  const books = new Map((booksResult.ok ? booksResult.books : []).map((b) => [b.id, b]));

  const head = (
    <>
      <SectionHead title="Receive Books" description="Use this page when books arrive from your supplier." />
      <InfoNote>
        <b>Receiving adds copies to the campaign&apos;s stock.</b> It does not give books to students, and it does not change the stock used for ordinary
        sales. To give books to a student, use{" "}
        <Link href="/academy/books/distribution" className="font-semibold">
          Give Books to Students
        </Link>
        .
      </InfoNote>
    </>
  );

  if (campaigns.length === 0) {
    return (
      <>
        {head}
        <EmptyCard
          title="No campaigns to receive for"
          description="Receiving is recorded against a campaign. Create a campaign first."
          action={
            <GatedAction need="canManageCampaigns" dialog={{ kind: "campaign" }} variant="secondary">
              Create campaign
            </GatedAction>
          }
        />
      </>
    );
  }

  // Default campaign (design): the one being received, else a closed one
  // waiting for delivery, else an open one, else the newest. It is listed
  // first so FilterSelect's empty value stands for it.
  const rank = (st: string) => ({ receiving: 0, closed: 1, open: 2 })[st] ?? 3;
  const ordered = [...campaigns].sort((a, b) => rank(a.status) - rank(b.status));
  const selected = campaigns.find((c) => c.id === get("campaign")) ?? ordered[0];
  const rows = selected.books
    .map((b) => ({ ...b, book: books.get(b.bookId), short: Math.max(0, b.ordered - b.usable) }))
    .sort((a, b) => (a.book?.name ?? "").localeCompare(b.book?.name ?? ""));
  const history = receipts.filter((r) => r.campaignId === selected.id);
  const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + pick(r), 0);

  return (
    <>
      {head}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="text-[13px] font-semibold">Campaign</span>
        <FilterSelect param="campaign" label="Campaign" options={ordered.map((c, i) => ({ value: i === 0 ? "" : c.id, label: c.name }))} />
        <span className="text-[13px] text-muted">
          Campaign status: {CAMPAIGN_STATUS_LABEL[selected.status]}. Expected arrival {formatIsoDate(selected.expectedArrivalOn)}. Damaged copies are not added to usable
          stock.
        </span>
      </div>
      <KpiGrid
        items={[
          { label: "Quantity Ordered", value: sum((r) => r.ordered), sub: `Copies in ${selected.name}` },
          { label: "Quantity Received", value: sum((r) => r.received), sub: "Copies delivered" },
          { label: "Damaged Copies", value: sum((r) => r.damaged), sub: "Not added to stock" },
          { label: "Remaining Quantity", value: sum((r) => r.short), sub: "Still to arrive" },
        ]}
      />
      {rows.length === 0 ? (
        <EmptyCard
          title="This campaign has no books"
          description="Add books to the campaign to receive them."
          action={
            <GatedAction need="canManageCampaigns" dialog={{ kind: "campaign", campaignId: selected.id }} variant="secondary">
              Edit campaign
            </GatedAction>
          }
        />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,230px),1fr))] gap-4">
          {rows.map((r) => {
            const last = history.find((h) => h.bookId === r.bookId);
            const badge = !r.received ? { label: "Not received yet", tone: "gray" as const } : r.usable < r.ordered ? { label: "Partly received", tone: "amber" as const } : { label: "All received", tone: "green" as const };
            const remain = r.short ? String(r.short) : r.usable > r.ordered ? `+${r.usable - r.ordered} extra` : "0";
            return (
              <article key={r.bookId} className={`${CARD} flex min-w-0 flex-col gap-3 p-4`}>
                <div className="flex min-w-0 items-center gap-3">
                  {r.book && <SubjectTile book={r.book} />}
                  <div className="min-w-0">
                    <p className="font-semibold leading-snug [overflow-wrap:anywhere]">{r.book?.name ?? "Book"}</p>
                    <p className="text-xs text-muted">{[r.book?.subject, r.book?.classLevel].filter(Boolean).join(" · ") || "—"}</p>
                  </div>
                </div>
                <div className="[&>span]:w-full">
                  <ToneBadge badge={badge} />
                </div>
                <div>
                  <p className="mb-1 text-xs text-muted">
                    {r.usable} of {r.ordered} usable copies received
                  </p>
                  <div className="h-2 overflow-hidden rounded bg-[#F1F2F5]">
                    <div className={`h-full rounded ${r.short ? "bg-brand" : "bg-[#166534]"}`} style={{ width: `${percent(Math.min(r.usable, r.ordered), Math.max(r.ordered, 1))}%` }} />
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {[
                    ["Ordered", String(r.ordered), ""],
                    ["Received", String(r.received), ""],
                    ["Damaged", String(r.damaged), ""],
                    ["Remaining", remain, r.short ? "text-[#92400E]" : "text-[#166534]"],
                  ].map(([label, value, color]) => (
                    <div key={label} className="min-w-0">
                      <div className="text-xs text-muted">{label}</div>
                      <div className={`text-[15px] font-bold tabular-nums ${color}`}>{value}</div>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted">{last ? `Last received ${formatIsoDate(last.receivedOn)}` : "Nothing received yet"}</p>
                <ReceiveButton campaignId={selected.id} bookId={r.bookId} primary={r.short > 0} />
              </article>
            );
          })}
        </div>
      )}

      <h3 className="mt-8 text-base font-bold">Receiving history</h3>
      <p className="mb-3 text-sm text-muted">Every delivery recorded for this campaign.</p>
      {history.length === 0 ? (
        <EmptyCard
          title="Nothing received yet"
          description="Receiving history appears after the first delivery is recorded."
          action={
            <GatedAction need="canManageCampaigns" dialog={{ kind: "receive", campaignId: selected.id }} variant="secondary">
              Receive Books
            </GatedAction>
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {paginate(history, page, PAGE_SIZE).map((h) => (
            <div
              key={h.id}
              className={`${CARD} grid grid-cols-3 items-center gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[110px_minmax(0,2fr)_70px_70px_70px_minmax(0,1fr)]`}
            >
              <div>
                <p className="text-xs text-muted">Date Received</p>
                <p className="font-semibold">{formatIsoDate(h.receivedOn)}</p>
              </div>
              <div className="col-span-2 min-w-0 md:col-span-1">
                <p className="font-semibold [overflow-wrap:anywhere]">{books.get(h.bookId)?.name ?? "Book"}</p>
                <p className="truncate text-xs text-muted">{h.note ?? "None"}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Received</p>
                <p className="font-bold tabular-nums">{h.quantityReceived}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Damaged</p>
                <p className="font-bold tabular-nums">{h.damagedQuantity}</p>
              </div>
              <div>
                <p className="text-xs text-muted">Usable</p>
                <p className="font-bold tabular-nums">{h.quantityReceived - h.damagedQuantity}</p>
              </div>
              <p className="col-span-3 text-xs text-muted md:col-span-1">By {h.recordedByLabel}</p>
            </div>
          ))}
        </div>
      )}
      <div className="mt-2">
        <Pager page={page} pageSize={PAGE_SIZE} total={history.length} params={params} />
      </div>
    </>
  );
}
