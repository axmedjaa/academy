import Link from "next/link";
import { redirect } from "next/navigation";
import { PREORDER_DISTRIBUTION_LABEL, PREORDER_PAYMENT_METHOD_LABEL, PREORDER_PAYMENT_STATUS_LABEL } from "@/lib/academies/book-preorder-math";
import { formatMoney } from "@/lib/ui/money";
import { PageMessage } from "@/app/academy/_shell/ui";
import { getPreorderHistory } from "../../books-data";
import { CARD, EmptyCard, InfoNote, KpiGrid, Pager, SectionHead, paginate, readParams } from "../../books-ui";
import { formatIsoDate, sumByCurrency } from "../../books-view";

const PAGE_SIZE = 10;

/**
 * Old pre-orders (read only): the student pre-orders, their payments and
 * the books handed over, recorded before Book Management was simplified.
 * Nothing here can be changed; the records are kept as they were. Same
 * permission, tenant and branch scope as before. Linked from Give Books.
 */
export default async function OldPreordersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const result = await getPreorderHistory();
  if (!result) redirect("/login");
  if (!result.ok) {
    return <PageMessage title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={result.error.message} />;
  }
  const params = await searchParams;
  const { page } = readParams(params);
  const { orders, campaigns } = result.overview;
  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]));
  const payments = orders.flatMap((o) => o.payments.map((p) => ({ p, o }))).sort((a, b) => (a.p.paidOn < b.p.paidOn ? 1 : -1));

  return (
    <>
      <Link href="/academy/books/distribution" className="mb-4 inline-flex min-h-11 items-center gap-1 font-semibold">
        ← Give Books
      </Link>
      <SectionHead title="Old pre-orders" description="Student pre-orders recorded before Book Management was simplified. Read only." />
      <InfoNote>
        <b>These records can&apos;t be changed.</b> New orders, their payments and hand-overs are under the Orders tab.
      </InfoNote>
      {orders.length === 0 ? (
        <EmptyCard title="No old pre-orders" description="This academy has no pre-order records." />
      ) : (
        <>
          <KpiGrid
            items={[
              { label: "Pre-orders", value: orders.length },
              { label: "Paid by students", value: sumByCurrency(orders.map((o) => ({ cents: o.paidCents, currency: o.currency }))) },
              { label: "Unpaid balance", value: sumByCurrency(orders.map((o) => ({ cents: o.balanceCents, currency: o.currency }))) },
            ]}
          />
          <h3 className="mb-2 font-bold">Pre-orders</h3>
          <div className={`${CARD} overflow-hidden`}>
            {paginate(orders, page, PAGE_SIZE).map((o, i) => (
              <div key={o.id} className={`grid grid-cols-2 items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_repeat(3,minmax(0,0.8fr))_minmax(0,1fr)] ${i ? "border-t border-border" : ""}`}>
                <div className="col-span-2 min-w-0 md:col-span-1">
                  <p className="truncate font-semibold">{o.buyerName}</p>
                  <p className="truncate text-xs text-muted">
                    {o.reference} · {o.studentNumber ?? o.buyerPhone ?? "Other person"}
                  </p>
                </div>
                <p className="min-w-0 truncate text-sm">{campaignName.get(o.campaignId) ?? "Campaign"}</p>
                <div>
                  <p className="text-xs text-muted">Total</p>
                  <p className="tabular-nums">{formatMoney(o.totalCents, o.currency)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted">Paid</p>
                  <p className="tabular-nums">{formatMoney(o.paidCents, o.currency)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted">Given</p>
                  <p className="tabular-nums">
                    {o.given} of {o.copies}
                  </p>
                </div>
                <p className="text-xs text-muted">
                  {PREORDER_PAYMENT_STATUS_LABEL[o.paymentStatus]} · {PREORDER_DISTRIBUTION_LABEL[o.distributionStatus]}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-2">
            <Pager page={page} pageSize={PAGE_SIZE} total={orders.length} params={params} />
          </div>

          <h3 className="mb-2 mt-6 font-bold">Payments received</h3>
          {payments.length === 0 ? (
            <EmptyCard title="No payments" description="No payment was recorded on these pre-orders." />
          ) : (
            <div className={`${CARD} overflow-hidden`}>
              {payments.map(({ p, o }, i) => (
                <div key={p.id} className={`grid grid-cols-2 items-center gap-3 px-4 py-3 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] ${i ? "border-t border-border" : ""}`}>
                  <div>
                    <p className="font-bold tabular-nums">{formatMoney(p.amountCents, o.currency)}</p>
                    <p className="text-xs text-muted">{formatIsoDate(p.paidOn)}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{o.buyerName}</p>
                    <p className="text-xs text-muted">{o.reference}</p>
                  </div>
                  <div className="min-w-0">
                    <p>{PREORDER_PAYMENT_METHOD_LABEL[p.method]}</p>
                    <p className="truncate text-xs text-muted">{p.reference ?? "No reference"}</p>
                  </div>
                  <p className="min-w-0 truncate text-xs text-muted">
                    {p.verified ? "Verified" : "Not verified"} · by {p.recordedByLabel}
                  </p>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
