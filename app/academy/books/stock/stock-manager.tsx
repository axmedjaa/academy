"use client";

import { useState } from "react";
import type { BookRecord } from "@/lib/academies/books";
import { getStockStatus, LOW_STOCK_THRESHOLD } from "@/lib/academies/book-stock";
import { Badge, Field, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { getStatusTone } from "@/lib/ui/status";

function formatMoney(amountCents: number, currency: string): string {
  return `${currency} ${(amountCents / 100).toFixed(2)}`;
}

const STOCK_STATUS_LABEL: Record<ReturnType<typeof getStockStatus>, string> = {
  out_of_stock: "Out of stock",
  low_stock: "Low stock",
  in_stock: "In stock",
};

interface Props {
  books: BookRecord[];
  coverUrls: Record<string, string | null>;
  recentSaleCounts: Record<string, number>;
}

type StockFilter = "all" | "in_stock" | "low_stock" | "out_of_stock";

export function StockManager({ books, coverUrls, recentSaleCounts }: Props) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StockFilter>("all");

  const visibleBooks = books.filter((book) => {
    const q = search.trim().toLowerCase();
    const matchesSearch =
      q === "" ||
      book.name.toLowerCase().includes(q) ||
      (book.isbn?.toLowerCase().includes(q) ?? false) ||
      (book.author?.toLowerCase().includes(q) ?? false);
    const matchesStatus = statusFilter === "all" || getStockStatus(book.stockQuantity) === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <Section>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Field label="Search" className="max-w-xs">
          <input
            type="search"
            placeholder="Name, ISBN, or author…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Stock level" className="max-w-xs">
          <select className={inputClass} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StockFilter)}>
            <option value="all">All</option>
            <option value="in_stock">In stock</option>
            <option value="low_stock">Low stock (≤ {LOW_STOCK_THRESHOLD})</option>
            <option value="out_of_stock">Out of stock</option>
          </select>
        </Field>
      </div>

      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Cover</th>
            <th className={th}>Name</th>
            <th className={th}>Price</th>
            <th className={th}>Quantity</th>
            <th className={th}>Status</th>
            <th className={th}>Recent sales (30d)</th>
          </tr>
        </thead>
        <tbody>
          {visibleBooks.length === 0 ? (
            <tr>
              <td colSpan={6} className={`${td} text-center text-muted`}>
                No books match this filter.
              </td>
            </tr>
          ) : (
            visibleBooks.map((book) => {
              const status = getStockStatus(book.stockQuantity);
              return (
                <tr key={book.id} className={trHover}>
                  <td className={td}>
                    <div className="flex h-12 w-10 items-center justify-center overflow-hidden rounded border border-border bg-surface">
                      {coverUrls[book.id] ? (
                        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed R2 URL.
                        <img src={coverUrls[book.id]!} alt={`${book.name} cover`} className="h-full w-full object-cover" />
                      ) : (
                        <span className="text-[10px] text-muted">No cover</span>
                      )}
                    </div>
                  </td>
                  <td className={`${td} font-medium`}>
                    {book.name}
                    {book.author && <div className="text-xs text-muted">{book.author}</div>}
                  </td>
                  <td className={td}>{formatMoney(book.priceCents, book.currency)}</td>
                  <td className={td}>{book.stockQuantity}</td>
                  <td className={td}>
                    <Badge label={STOCK_STATUS_LABEL[status]} tone={getStatusTone(status)} />
                  </td>
                  <td className={td}>{recentSaleCounts[book.id] ?? 0}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </TableWrap>
    </Section>
  );
}
