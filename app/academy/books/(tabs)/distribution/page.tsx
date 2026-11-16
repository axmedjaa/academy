import Link from "next/link";
import { redirect } from "next/navigation";
import type { BookOrderView } from "@/lib/academies/book-orders";
import { formatMoney } from "@/lib/ui/money";
import { PageMessage } from "@/app/academy/_shell/ui";
import { SearchField } from "@/app/academy/_shell/filter-controls";
import { getBookStudents, getBooksOverview } from "../../books-data";
import { CancelOrderButton, GatedAction, PayButton, PillChips, ToneBadge } from "../../books-sections";
import { BTN_SECONDARY, CARD, EmptyCard, InfoNote, SectionHead, readParams } from "../../books-ui";
import { formatIsoDate, orderNo, orderPaymentBadge, plural } from "../../books-view";

/**
 * Give Books: the books students (or other people) buy from the academy.
 * Each book order shows what was paid (money coming IN, posted as income)
 * and the stock of each book; staff record the buyer's payments and give
 * the books only when the order is FULLY paid and the copies are in stock
 * (the server checks both again). Stock is managed in the Books tab. Every
 * hand-over is recorded with the date and the staff
 * member, and shows on the student's profile.
 */
export default async function GiveBooksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { ordersResult, booksResult } = overview;
  if (!ordersResult.ok) {
    return <PageMessage title={ordersResult.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={ordersResult.error.message} />;
  }
  const params = await searchParams;
  const { get } = readParams(params);
  const q = get("q").trim().toLowerCase();
  const studentId = get("student");
  const show = get("show");
  const students = await getBookStudents();
  const stockOf = new Map((booksResult.ok ? booksResult.books : []).map((b) => [b.id, b.stockQuantity]));
  const { orders, issues } = ordersResult.overview;

  const student = students.find((s) => s.id === studentId) ?? null;
  const live = orders.filter((o) => o.status !== "cancelled");
  const open = live.filter((o) => o.issuedCopies < o.copies);
  const readyToGive = (o: BookOrderView) => o.outstandingCents === 0 && o.items.some((i) => i.quantity > i.issuedQuantity && (stockOf.get(i.bookId) ?? 0) > 0);
  const matches = q ? students.filter((s) => `${s.fullName} ${s.studentNumber} ${s.phone ?? ""}`.toLowerCase().includes(q)).slice(0, 12) : [];
  const listed = student
    ? live.filter((o) => o.studentId === student.id)
    : open.filter((o) => (show === "ready" ? readyToGive(o) : show === "unpaid" ? o.outstandingCents > 0 : true)).filter((o) => !q || `${o.orderNumber} ${o.buyerName} ${o.studentNumber ?? ""} ${o.buyerPhone ?? ""}`.toLowerCase().includes(q));
  const given = student ? issues.filter((x) => x.studentId === student.id) : issues.slice(0, 10);

  function OrderCard({ o }: { o: BookOrderView }) {
    const fullyPaid = o.outstandingCents === 0;
    const toGive = o.items.filter((i) => i.quantity > i.issuedQuantity);
    const canGiveNow = fullyPaid && toGive.some((i) => (stockOf.get(i.bookId) ?? 0) > 0);
    return (
      <section className={`${CARD} overflow-hidden`}>
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4">
          <div className="min-w-0">
            <p className="font-semibold">
              <Link href={`/academy/books/orders/${o.id}`} className="text-muted tabular-nums">
                {orderNo(o.orderNumber)}
              </Link>{" "}
              {o.studentId ? <Link href={`/academy/books/distribution?student=${o.studentId}`}>{o.buyerName}</Link> : o.buyerName}
              <span className="font-normal text-muted"> · {o.studentNumber ?? `Other buyer${o.buyerPhone ? `, ${o.buyerPhone}` : ""}`}</span>
            </p>
            <p className="text-sm text-muted tabular-nums">
              Ordered {formatIsoDate(o.orderDate)} · Paid {formatMoney(o.paidCents, o.currency)} of {formatMoney(o.totalCents, o.currency)}
              {o.discountCents > 0 ? ` (after ${formatMoney(o.discountCents, o.currency)} discount)` : ""}
              {o.outstandingCents > 0 ? ` · ${formatMoney(o.outstandingCents, o.currency)} outstanding` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ToneBadge badge={orderPaymentBadge(o.paymentStatus)} />
            <ToneBadge badge={o.issuedCopies >= o.copies ? { label: "All given", tone: "green" } : o.issuedCopies > 0 ? { label: "Partly given", tone: "blue" } : { label: "Not given yet", tone: "gray" }} />
          </div>
        </div>
        <div className="mt-3">
          {o.items.map((i) => {
            const stock = stockOf.get(i.bookId) ?? 0;
            const left = i.quantity - i.issuedQuantity;
            return (
              <div key={i.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-border px-4 py-2.5 text-sm">
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {i.bookName} <span className="text-muted">· {formatMoney(i.unitCostCents, o.currency)} each</span>
                </span>
                <span className="text-right tabular-nums text-muted">
                  {i.issuedQuantity} of {i.quantity} given
                  {left > 0 && <span className={stock >= left ? "text-[#166534]" : "text-[#B45309]"}> · {stock} in stock</span>}
                </span>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-app px-4 py-3">
          {toGive.length > 0 && !fullyPaid && <span className="mr-auto text-sm text-[#92400E]">Fully pay the order before giving books.</span>}
          {toGive.length > 0 && fullyPaid && !canGiveNow && <span className="mr-auto text-sm text-[#92400E]">Not enough copies in stock yet.</span>}
          {o.outstandingCents > 0 && <PayButton orderId={o.id} />}
          {o.paidCents === 0 && o.issuedCopies === 0 && (
            <>
              <GatedAction need="canManageOrders" dialog={{ kind: "discount", orderId: o.id }} variant="secondary">
                Change discount
              </GatedAction>
              <CancelOrderButton orderId={o.id} summary={`Order for ${o.buyerName}: ${plural(o.copies, "copy", "copies")}, ${formatMoney(o.totalCents, o.currency)}.`} />
            </>
          )}
          {toGive.length > 0 && canGiveNow && (
            <GatedAction need="canIssue" dialog={{ kind: "issue", orderId: o.id }}>
              Give books
            </GatedAction>
          )}
        </div>
      </section>
    );
  }

  return (
    <>
      <SectionHead title="Give Books" description="Give the books on an order once it is fully paid and the copies are in stock." />
      <InfoNote>
        <b>Books are given only when the order is fully paid and the copies are in stock.</b> Giving books lowers the stock by the number given.
      </InfoNote>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SearchField placeholder="Find a student or buyer by name, student number or phone" />
        {student && (
          <Link href="/academy/books/distribution" className={BTN_SECONDARY}>
            All orders
          </Link>
        )}
      </div>

      {!student && q && matches.length > 0 && (
        <div className={`${CARD} mb-6 overflow-hidden`}>
          {matches.map((s, i) => (
            <Link
              key={s.id}
              href={`/academy/books/distribution?student=${s.id}`}
              className={`flex items-center justify-between gap-3 px-4 py-3 !text-ink !no-underline hover:bg-app hover:!no-underline ${i ? "border-t border-border" : ""}`}
            >
              <span className="min-w-0">
                <span className="block truncate font-semibold">{s.fullName}</span>
                <span className="block text-xs text-muted">
                  {s.studentNumber} · {s.branchName}
                </span>
              </span>
              <span className="text-xs text-muted">{plural(live.filter((o) => o.studentId === s.id).length, "order", "orders")}</span>
            </Link>
          ))}
        </div>
      )}

      {student ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-bold">
              <Link href={`/academy/students/${student.id}`}>{student.fullName}</Link>
            </h3>
            <p className="text-sm text-muted">
              {student.studentNumber} · {student.branchName}
            </p>
          </div>
          <GatedAction need="canManageOrders" dialog={{ kind: "order", studentId: student.id }}>
            Create Order
          </GatedAction>
        </div>
      ) : (
        open.length > 0 && (
          <PillChips
            param="show"
            label="Filter orders"
            options={[
              { value: "", label: "All open orders", count: open.length },
              { value: "ready", label: "Ready to give", count: open.filter(readyToGive).length },
              { value: "unpaid", label: "Waiting for payment", count: open.filter((o) => o.outstandingCents > 0).length },
            ]}
          />
        )
      )}

      {listed.length === 0 ? (
        <EmptyCard
          title={student ? "No book orders" : open.length ? "No orders match" : "No open book orders"}
          description={student ? "Create an order for the books this student needs; it can be paid in parts and the books given once it is fully paid and in stock." : "Create an order with Create Order. Its books are given here once it is fully paid and in stock."}
        />
      ) : (
        <div className="mb-6 flex flex-col gap-4">
          {listed.map((o) => (
            <OrderCard key={o.id} o={o} />
          ))}
        </div>
      )}

      <h3 className="mb-2 mt-2 text-base font-bold">{student ? `Books given to ${student.fullName}` : "Recently given"}</h3>
      {given.length === 0 ? (
        <EmptyCard title="No books given yet" description="Each time books are given they are listed here and on the student's profile." />
      ) : (
        <div className={`${CARD} overflow-hidden`}>
          {given.map((x, i) => (
            <div key={x.id} className={`grid grid-cols-2 items-center gap-x-3 gap-y-1 px-4 py-3 md:grid-cols-[110px_minmax(0,1.3fr)_minmax(0,1.4fr)_60px_minmax(0,1fr)] ${i ? "border-t border-border" : ""}`}>
              <p className="font-semibold tabular-nums">{formatIsoDate(x.issuedOn)}</p>
              <p className="min-w-0 truncate">{x.recipientName}</p>
              <p className="col-span-2 min-w-0 [overflow-wrap:anywhere] md:col-span-1">{x.bookName}</p>
              <p className="font-bold tabular-nums">×{x.quantity}</p>
              <p className="min-w-0 truncate text-xs text-muted">By {x.issuedByLabel}</p>
            </div>
          ))}
        </div>
      )}
      <p className="mt-6 text-sm text-muted">
        <Link href="/academy/books/pre-orders">Old pre-orders (read only)</Link>
      </p>
    </>
  );
}
