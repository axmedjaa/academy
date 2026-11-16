import type { ReactNode } from "react";
import type { BookRecord } from "@/lib/academies/books";
import type { BookOrderView } from "@/lib/academies/book-orders";
import type { BookBranchOption, BookStudentOption } from "@/lib/academies/book-orders";
import { BooksActionsProvider, type BooksClientData } from "./books-actions";
import { BooksSectionNav, HeroActions, HeroGate, type NavPermissions } from "./books-tabs";

/**
 * Book Management header: the burgundy hero with the main actions (Add
 * Book, Create Order, Give Books), then the Books / Orders tabs with their
 * section pills. Rendered once by the shared Books layout, so it stays in
 * place while the sections switch. All sections share the `academy.books`
 * permission row; buttons a member can't use are omitted, not disabled.
 */
export function BooksShell({
  books,
  coverUrls,
  orders,
  students,
  branches,
  permissions,
  children,
}: {
  books: BookRecord[];
  coverUrls: Record<string, string>;
  orders: BookOrderView[];
  students: BookStudentOption[];
  branches: BookBranchOption[];
  permissions: NavPermissions;
  children: ReactNode;
}) {
  const subjects = [...new Set(books.map((b) => b.subject).filter((v): v is string => Boolean(v)))].sort();
  const classes = [...new Set(books.map((b) => b.classLevel).filter((v): v is string => Boolean(v)))].sort();
  const clientData: BooksClientData = {
    canManageOrders: permissions.canManageOrders,
    canIssue: permissions.canIssue,
    canManageBooks: permissions.canManageBooks,
    canSell: permissions.canSell,
    books,
    coverUrls,
    orders: orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      buyerName: o.buyerName,
      studentId: o.studentId,
      studentNumber: o.studentNumber,
      orderDate: o.orderDate,
      status: o.status,
      currency: o.currency,
      subtotalCents: o.subtotalCents,
      discountCents: o.discountCents,
      totalCents: o.totalCents,
      paidCents: o.paidCents,
      outstandingCents: o.outstandingCents,
      items: o.items.map((i) => ({ id: i.id, bookId: i.bookId, bookName: i.bookName, quantity: i.quantity, quantityReceived: i.quantityReceived, issuedQuantity: i.issuedQuantity })),
    })),
    students,
    branches,
    suggestions: { subjects, classes },
  };

  const hero = (
    <section className="relative mb-7 overflow-hidden rounded-[20px] bg-[linear-gradient(135deg,#850019_0%,#6B0014_55%,#5E0012_100%)] p-[22px] text-white shadow-[0_10px_28px_rgba(133,0,25,0.28)] sm:px-8 sm:pb-8 sm:pt-9">
      <div aria-hidden="true" className="absolute -right-10 -top-24 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(245,182,56,0.30),rgba(245,182,56,0)_68%)]" />
      <div className="relative min-w-0">
        <h1 className="text-[28px] font-bold leading-[1.1] tracking-[-0.02em] sm:text-[36px]">Book Management</h1>
        <p className="mt-3 max-w-[60ch] leading-normal text-white/90">Manage academy books, orders, payments and books issued to students.</p>
      </div>
      <HeroActions can={permissions} />
    </section>
  );

  const compact = (
    <div className="mb-5">
      <h1 className="text-[28px] font-bold leading-tight tracking-[-0.015em]">Book Management</h1>
      <p className="mt-1.5 text-muted">Manage academy books, orders, payments and books issued to students.</p>
    </div>
  );

  return (
    <BooksActionsProvider data={clientData}>
      {/* The design's 14px base scale for everything in Book Management. */}
      <div className="text-sm leading-[1.45]">
        <HeroGate hero={hero} compact={compact} />
        <BooksSectionNav can={permissions} />
        {children}
      </div>
    </BooksActionsProvider>
  );
}
