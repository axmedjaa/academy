import Link from "next/link";
import { redirect } from "next/navigation";
import { listBookStockMovements } from "@/lib/academies/books";
import { STOCK_REASON_LABEL, STOCK_SOURCE_LABEL } from "@/lib/academies/book-stock";
import { formatDate } from "@/lib/ui/date";
import { PageMessage, trHover } from "@/app/academy/_shell/ui";
import { DataTable, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { getBooksOverview } from "../../../books-data";
import { StockAdjustButton, StockBadge } from "../../../books-client";
import { EmptyCard, KpiGrid } from "../../../books-ui";

/**
 * One book's stock history (Books > Stock > History): every movement, newest
 * first. Manual adjustments with their reason and note, sales, copies given
 * from orders, and copies returned on refunds, each with stock before and
 * after and who did it. Staff who manage books can adjust stock from here.
 * Another academy's book reads as not found.
 */
export default async function BookStockHistoryPage({ params }: { params: Promise<{ bookId: string }> }) {
  const { bookId } = await params;
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const back = (
    <Link href="/academy/books/stock" className="mb-4 inline-flex min-h-11 items-center gap-1 font-semibold">
      ← Stock
    </Link>
  );

  const result = await listBookStockMovements(overview.context, bookId);
  if (!result.ok) {
    if (result.error.code === "not_found") {
      return (
        <>
          {back}
          <EmptyCard title="This book was not found." description="The link may be wrong, or the book belongs to another academy." />
        </>
      );
    }
    return <PageMessage title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={result.error.message} />;
  }
  const { book, movements, canManage } = result;
  const added = movements.filter((m) => m.delta > 0).reduce((n, m) => n + m.delta, 0);
  const removed = movements.filter((m) => m.delta < 0).reduce((n, m) => n - m.delta, 0);

  return (
    <>
      {back}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-muted">Stock history</p>
          <h2 className="text-xl font-bold [overflow-wrap:anywhere]">{book.name}</h2>
          {book.author && <p className="text-sm text-muted">{book.author}</p>}
        </div>
        {canManage && (
          <span className="flex flex-wrap gap-2">
            <StockAdjustButton direction="in" book={{ id: book.id, name: book.name, stockQuantity: book.stockQuantity }} />
            <StockAdjustButton direction="out" book={{ id: book.id, name: book.name, stockQuantity: book.stockQuantity }} />
          </span>
        )}
      </div>

      <KpiGrid
        items={[
          { label: "In stock now", value: book.stockQuantity, sub: <StockBadge quantity={book.stockQuantity} inactive={book.status !== "active"} /> },
          { label: "Copies in", value: added, sub: "In the movements below" },
          { label: "Copies out", value: removed, sub: "In the movements below" },
        ]}
      />

      {movements.length === 0 ? (
        <EmptyCard
          title="No stock movements yet."
          description="Adjustments, sales, books given from orders and returned copies will be listed here. The opening stock was set when the book was added."
        />
      ) : (
        <DataTable stackBelow={760}>
          <thead>
            <tr>
              <th className={rtTh}>Date</th>
              <th className={rtTh}>Movement</th>
              <th className={`${rtTh} text-right`}>Change</th>
              <th className={`${rtTh} text-right`}>Stock after</th>
              <th className={rtTh}>By</th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id} className={trHover}>
                <td className={`${rtTd} whitespace-nowrap`} data-label="Date">
                  {formatDate(m.at)}
                </td>
                <td className={rtTd} data-label="Movement">
                  <span className="block font-semibold">
                    {m.source === "adjustment" && m.reason ? STOCK_REASON_LABEL[m.reason] : STOCK_SOURCE_LABEL[m.source]}
                  </span>
                  {m.source === "adjustment" && <span className="block text-xs text-muted">{STOCK_SOURCE_LABEL.adjustment}</span>}
                  {m.note && <span className="block text-sm text-[#4B5563] [overflow-wrap:anywhere]">{m.note}</span>}
                </td>
                <td
                  className={`${rtTd} text-right font-semibold tabular-nums ${m.delta > 0 ? "text-[#166534]" : m.delta < 0 ? "text-[#991B1B]" : ""}`}
                  data-label="Change"
                >
                  {m.delta > 0 ? `+${m.delta}` : m.delta}
                </td>
                <td className={`${rtTd} text-right tabular-nums`} data-label="Stock after">
                  {m.stockAfter ?? "—"}
                </td>
                <td className={rtTd} data-label="By">
                  {m.byLabel}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </>
  );
}
