"use client";

import Link from "next/link";
import type { BookIssueView } from "@/lib/academies/book-orders";
import { formatIsoDate } from "@/app/academy/books/books-view";
import { BlockTitle, DataTable, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { trHover } from "@/app/academy/_shell/ui";

/** Student profile: every book issued to this student, newest first, with
 * the quantity, issue date and the staff member who issued it. */
export function StudentBooksCard({ issues }: { issues: BookIssueView[] }) {
  const copies = issues.reduce((sum, issue) => sum + issue.quantity, 0);
  return (
    <div className="mt-6">
      <BlockTitle
        actions={
          <Link href="/academy/books/distribution" className="text-sm font-semibold">
            Issued Books
          </Link>
        }
      >
        Books issued {issues.length > 0 && <span className="font-normal text-muted">({copies} {copies === 1 ? "copy" : "copies"})</span>}
      </BlockTitle>
      <DataTable stackBelow={600}>
        <thead>
          <tr>
            <th className={rtTh}>Book</th>
            <th className={`${rtTh} text-right`}>Quantity</th>
            <th className={rtTh}>Issued</th>
            <th className={rtTh}>Issued by</th>
          </tr>
        </thead>
        <tbody>
          {issues.length === 0 ? (
            <tr>
              <td colSpan={4} className={`${rtTd} text-center text-muted`}>
                No books have been issued to this student.
              </td>
            </tr>
          ) : (
            issues.map((issue) => (
              <tr key={issue.id} className={trHover}>
                <td className={`${rtTd} font-semibold`} data-label="Book">
                  {issue.bookName}
                  {issue.notes && <span className="block text-xs font-normal text-muted">{issue.notes}</span>}
                </td>
                <td className={`${rtTd} text-right tabular-nums`} data-label="Quantity">
                  {issue.quantity}
                </td>
                <td className={`${rtTd} tabular-nums`} data-label="Issued">
                  {formatIsoDate(issue.issuedOn)}
                </td>
                <td className={rtTd} data-label="Issued by">
                  {issue.issuedByLabel}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </DataTable>
    </div>
  );
}
