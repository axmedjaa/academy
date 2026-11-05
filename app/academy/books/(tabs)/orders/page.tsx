import Link from "next/link";
import { redirect } from "next/navigation";
import { PageMessage } from "@/app/academy/_shell/ui";
import { FilterSelect, SearchField } from "@/app/academy/_shell/filter-controls";
import { getBooksOverview } from "../../books-data";
import { GatedAction, PillChips, StepCards } from "../../books-sections";
import { BTN_SECONDARY, EmptyCard, KpiGrid, Pager, SectionHead, paginate, readParams } from "../../books-ui";
import { OrderCard } from "../../order-card";
import { buyerSearchText, plural, sumByCurrency, titlesLine } from "../../books-view";

const PAGE_SIZE = 6;

/**
 * Student Orders (design B03, step 3): one order per student with several
 * books, its reference, totals and payment progress. Search by student
 * name, number or order reference; filter by campaign and payment status.
 * Members limited to some branches see only their branches' orders.
 */
export default async function StudentOrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
  const pay = get("pay");
  const { orders, campaigns } = preordersResult.overview;
  const bookName = new Map((booksResult.ok ? booksResult.books : []).map((b) => [b.id, b.name]));

  const base = orders.filter(
    (o) => (!campaign || o.campaignId === campaign) && (!q || buyerSearchText(o).includes(q)),
  );
  const rows = base.filter((o) => !pay || o.paymentStatus === pay);
  const visible = paginate(rows, page, PAGE_SIZE);
  const money = (pick: (o: (typeof rows)[number]) => number) => sumByCurrency(rows.map((o) => ({ cents: pick(o), currency: o.currency })));

  return (
    <>
      <SectionHead title="Student Orders" description="Each order is for one student or another person and can include several books. Create the order first, then record the payment." />
      <StepCards
        steps={[
          { n: "1", title: "Create Order", sub: "Choose who is ordering and add books", dialog: { kind: "order" } },
          { n: "2", title: "Record Payment", sub: "Enter the amount paid, in full or in part", dialog: { kind: "pay" } },
          { n: "3", title: "Give Books", sub: "Once paid in full and verified", href: "/academy/books/distribution" },
        ]}
      />
      <KpiGrid
        items={[
          { label: "Orders", value: rows.length, sub: `${plural(rows.reduce((s, o) => s + o.copies, 0), "book copy", "book copies")} ordered` },
          { label: "Order Total", value: money((o) => o.totalCents), sub: "Value of these orders" },
          { label: "Amount Paid", value: money((o) => o.paidCents), sub: `${money((o) => o.unverifiedCents)} not verified yet` },
          { label: "Remaining Balance", value: money((o) => o.balanceCents), sub: `${plural(rows.filter((o) => o.balanceCents > 0).length, "order", "orders")} still owe money` },
        ]}
      />
      {orders.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap gap-3">
            <SearchField placeholder="Search name, student ID, phone or order" />
            <FilterSelect param="campaign" label="Campaign" options={[{ value: "", label: "All campaigns" }, ...campaigns.map((c) => ({ value: c.id, label: c.name }))]} />
          </div>
          <PillChips
            param="pay"
            label="Filter by payment"
            options={[
              { value: "", label: "All orders", count: base.length },
              { value: "unpaid", label: "Unpaid", count: base.filter((o) => o.paymentStatus === "unpaid").length },
              { value: "partially_paid", label: "Partially paid", count: base.filter((o) => o.paymentStatus === "partially_paid").length },
              { value: "paid", label: "Paid in full", count: base.filter((o) => o.paymentStatus === "paid").length },
            ]}
          />
        </>
      )}
      {visible.length === 0 ? (
        orders.length === 0 ? (
          <EmptyCard
            title="No orders yet"
            description="Create the first order for a student or other buyer. One order can include several books."
            action={
              <GatedAction need="canManage" dialog={{ kind: "order" }} variant="secondary">
                Create Order
              </GatedAction>
            }
          />
        ) : (
          <EmptyCard
            title="No orders match"
            description="Try a different search or clear the filters."
            action={
              <Link href="/academy/books/orders" className={BTN_SECONDARY}>
                Clear filters
              </Link>
            }
          />
        )
      ) : (
        visible.map((o) => <OrderCard key={o.id} order={o} titles={titlesLine(o.items.map((i) => bookName.get(i.bookId) ?? "Book"))} />)
      )}
      <div className="mt-2">
        <Pager page={page} pageSize={PAGE_SIZE} total={rows.length} params={params} />
      </div>
    </>
  );
}
