import Link from "next/link";
import { redirect } from "next/navigation";
import { getBookCoverUrl } from "@/lib/academies/books";
import { formatDate } from "@/lib/ui/date";
import { formatMoney } from "@/lib/ui/money";
import { PageMessage } from "@/app/academy/_shell/ui";
import { FilterSelect, SearchField } from "@/app/academy/_shell/filter-controls";
import { getBooksOverview } from "../../books-data";
import { PillChips } from "../../books-sections";
import { BTN_SECONDARY, CARD, EmptyCard, InfoNote, KpiGrid, Pager, SectionHead, paginate, readParams } from "../../books-ui";
import { GiveRow, type GiveRowData } from "../../distribution-client";
import { buyerOf, buyerSearchText, distributionBadge, initials } from "../../books-view";
import { PREORDER_PAYMENT_STATUS_LABEL, maxGivable } from "@/lib/academies/book-preorder-math";

const PAGE_SIZE = 5;

/**
 * Give Books to Students (design B08, step 4): find the student's order,
 * see what is ready (received, undamaged and not yet given from the
 * campaign's pool), and record what the student collects — all at once or
 * in parts. Payment status is shown for information only.
 */
export default async function GiveBooksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { booksResult, preordersResult } = overview;
  if (!preordersResult.ok) {
    return <PageMessage title={preordersResult.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={preordersResult.error.message} />;
  }
  const params = await searchParams;
  const { get, page } = readParams(params);
  const q = get("q").toLowerCase();
  const campaign = get("campaign");
  // The design opens on "Ready to give"; "all" shows every order.
  const statParam = get("stat");
  const stat = statParam === "" ? "ready" : statParam === "all" ? "" : statParam;
  const { orders, campaigns } = preordersResult.overview;
  const books = new Map((booksResult.ok ? booksResult.books : []).map((b) => [b.id, b]));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  const pool = (campaignId: string, bookId: string) => campaignById.get(campaignId)?.books.find((b) => b.bookId === bookId)?.available ?? 0;
  // Books are given only when the order is paid in full and every payment
  // on it is verified; nothing is ready to give before that.
  const cleared = (o: (typeof orders)[number]) => o.balanceCents === 0 && o.unverifiedCents === 0;
  const readyOf = (o: (typeof orders)[number]) =>
    !cleared(o) ? 0 : o.items.reduce((s, i) => s + maxGivable(i.quantity, i.givenQuantity, pool(o.campaignId, i.bookId)), 0);

  const base = orders.filter((o) => (!campaign || o.campaignId === campaign) && (!q || buyerSearchText(o).includes(q)));
  const rows = base.filter(
    (o) =>
      !stat ||
      (stat === "ready"
        ? readyOf(o) > 0
        : stat === "unpaid"
          ? !cleared(o) && o.copies > o.given
          : stat === "await"
            ? o.copies > o.given
            : o.copies === o.given),
  );
  const visible = paginate(rows, page, PAGE_SIZE);

  const coverIds = [...new Set(visible.flatMap((o) => o.items.map((i) => i.bookId)))];
  const covers = new Map(await Promise.all(coverIds.map(async (id) => [id, await getBookCoverUrl(books.get(id)?.coverRef ?? null)] as const)));

  const data: GiveRowData[] = visible.map((o) => ({
    orderId: o.id,
    reference: o.reference,
    buyerName: o.buyerName,
    buyerId: buyerOf(o).id,
    buyerSub: buyerOf(o).sub,
    hold:
      o.balanceCents > 0
        ? { kind: "unpaid", outstanding: formatMoney(o.balanceCents, o.currency), paymentLabel: PREORDER_PAYMENT_STATUS_LABEL[o.paymentStatus] }
        : o.unverifiedCents > 0
          ? { kind: "unverified", unverified: formatMoney(o.unverifiedCents, o.currency) }
          : null,
    initials: initials(o.buyerName),
    campaignName: campaignById.get(o.campaignId)?.name ?? "Campaign",
    copies: o.copies,
    given: o.given,
    ready: readyOf(o),
    badge: distributionBadge(o.distributionStatus),
    lines: o.items.map((i) => {
      const book = books.get(i.bookId);
      return {
        bookId: i.bookId,
        title: book?.name ?? "Book",
        coverUrl: covers.get(i.bookId) ?? null,
        initials: initials(book?.name ?? "Book"),
        ordered: i.quantity,
        given: i.givenQuantity,
        max: !cleared(o) ? 0 : maxGivable(i.quantity, i.givenQuantity, pool(o.campaignId, i.bookId)),
      };
    }),
  }));

  const history = orders
    .flatMap((o) => o.handovers.map((h) => ({ h, o })))
    .sort((a, b) => b.h.createdAt.getTime() - a.h.createdAt.getTime());
  const histPage = Math.max(1, Number.parseInt(get("hpage"), 10) || 1);

  return (
    <>
      <SectionHead title="Give Books to Students" description="Use this page when a student or other buyer collects the books they ordered." />
      <InfoNote>
        <b>A book can be given when the order is paid in full and verified, and the book has been received.</b> Look for the green Ready to give
        label. If a book is not received yet, first use{" "}
        <Link href="/academy/books/receiving" className="font-semibold">
          Receive Books
        </Link>
        .
      </InfoNote>
      <KpiGrid
        items={[
          { label: "Students waiting", value: orders.filter((o) => o.copies > o.given).length },
          { label: "Books to give", value: orders.reduce((s, o) => s + o.copies - o.given, 0) },
          { label: "Books given", value: orders.reduce((s, o) => s + o.given, 0) },
        ]}
      />
      {orders.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap gap-3">
            <SearchField placeholder="Find student or buyer by name, ID, phone or order" />
            <FilterSelect param="campaign" label="Campaign" options={[{ value: "", label: "All campaigns" }, ...campaigns.map((c) => ({ value: c.id, label: c.name }))]} />
          </div>
          <PillChips
            param="stat"
            label="Filter"
            options={[
              { value: "", label: "Ready to give", count: base.filter((o) => readyOf(o) > 0).length },
              { value: "unpaid", label: "Waiting for payment", count: base.filter((o) => !cleared(o) && o.copies > o.given).length },
              { value: "await", label: "Waiting for books", count: base.filter((o) => o.copies > o.given).length },
              { value: "done", label: "All books given", count: base.filter((o) => o.copies === o.given).length },
              { value: "all", label: "All orders", count: base.length },
            ]}
          />
        </>
      )}
      {data.length === 0 ? (
        orders.length === 0 ? (
          <EmptyCard title="No orders yet" description="Books can be given once orders exist and are paid in full with verified payments." />
        ) : (
          <EmptyCard
            title={
              stat === "ready" && !q && !campaign
                ? "No books are ready to give yet"
                : stat === "unpaid" && !q && !campaign
                  ? "No order is waiting for payment or verification"
                  : stat === "await" && !q && !campaign
                    ? "No order is waiting for books"
                    : "No orders match"
            }
            description="Change the search or filters to see other orders."
            action={
              <Link href="/academy/books/distribution?stat=all" className={BTN_SECONDARY}>
                Show all orders
              </Link>
            }
          />
        )
      ) : (
        data.map((row) => <GiveRow key={row.orderId} row={row} initiallyOpen={rows.length === 1 && row.copies > row.given} />)
      )}
      <Pager page={page} pageSize={PAGE_SIZE} total={rows.length} params={params} />

      <h3 className="mt-8 text-base font-bold">Books given history</h3>
      <p className="mb-3 text-sm text-muted">Every time books were marked as given.</p>
      {history.length === 0 ? (
        <EmptyCard title="No books given yet" description="Each time books are marked as given they are listed here." />
      ) : (
        <div className="flex flex-col gap-2">
          {paginate(history, histPage, 8).map(({ h, o }) => (
            <div
              key={h.id}
              className={`${CARD} grid grid-cols-2 items-center gap-x-3 gap-y-2 px-4 py-3 md:grid-cols-[120px_minmax(0,1.4fr)_minmax(0,1.4fr)_80px_minmax(0,1fr)]`}
            >
              <div>
                <p className="text-xs text-muted">Date Given</p>
                <p className="font-semibold">{formatDate(h.createdAt)}</p>
              </div>
              <div className="min-w-0">
                <p className="truncate font-semibold">{o.buyerName}</p>
                <p className="text-xs text-muted">
                  {buyerOf(o).id} · {o.reference}
                </p>
              </div>
              <p className="col-span-2 min-w-0 [overflow-wrap:anywhere] md:col-span-1">{books.get(h.bookId)?.name ?? "Book"}</p>
              <div>
                <p className="text-xs text-muted">Quantity</p>
                <p className="font-bold tabular-nums">{h.quantity}</p>
              </div>
              <p className="text-xs text-muted">Given by {h.givenByLabel}</p>
            </div>
          ))}
        </div>
      )}
      {history.length > 8 && (
        <div className="mt-2 flex justify-end gap-2 text-sm">
          {histPage > 1 && (
            <Link href={{ query: { ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])), hpage: String(histPage - 1) } }} className={BTN_SECONDARY}>
              Previous
            </Link>
          )}
          {histPage * 8 < history.length && (
            <Link href={{ query: { ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])), hpage: String(histPage + 1) } }} className={BTN_SECONDARY}>
              Next
            </Link>
          )}
        </div>
      )}
    </>
  );
}
