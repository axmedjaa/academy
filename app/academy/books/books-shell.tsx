import type { ReactNode } from "react";
import type { BookRecord } from "@/lib/academies/books";
import type { BookSaleListRow } from "@/lib/academies/book-sales";
import type { PreorderBranchOption, PreorderOverview, PreorderStudentOption } from "@/lib/academies/book-preorders";
import { BooksActionsProvider, type BooksClientData } from "./books-actions";
import { BooksSectionNav, HeroActions, HeroGate, type NavPermissions } from "./books-tabs";

/**
 * Book Management header (design B01-B13, revised 2026-11-07): the burgundy
 * hero with the three main actions (Add Book, Sell Book, Pre-Order), then
 * the Books / Orders tabs with their section pills.
 * Rendered once by the shared Books layout, so it stays in place while the
 * sections switch. All sections share the `academy.books` permission row;
 * buttons a member can't use are omitted, not disabled.
 */
export function BooksShell({
  books,
  coverUrls,
  sales,
  preorders,
  students,
  branches,
  permissions,
  children,
}: {
  books: BookRecord[];
  coverUrls: Record<string, string>;
  sales: BookSaleListRow[] | null;
  preorders: PreorderOverview | null;
  students: PreorderStudentOption[];
  branches: PreorderBranchOption[];
  permissions: NavPermissions;
  children: ReactNode;
}) {
  const orders = preorders?.orders ?? [];
  const campaigns = preorders?.campaigns ?? [];
  const subjects = [...new Set(books.map((b) => b.subject).filter((v): v is string => Boolean(v)))].sort();
  const classes = [...new Set(books.map((b) => b.classLevel).filter((v): v is string => Boolean(v)))].sort();
  const clientData: BooksClientData = {
    canManage: permissions.canManage,
    canManageCampaigns: permissions.canManageCampaigns,
    canManageBooks: permissions.canManageBooks,
    canSell: permissions.canSell,
    books,
    coverUrls,
    campaigns,
    orders: orders.map((o) => ({
      id: o.id,
      reference: o.reference,
      campaignId: o.campaignId,
      buyerType: o.buyerType,
      studentId: o.studentId,
      buyerName: o.buyerName,
      studentNumber: o.studentNumber,
      buyerPhone: o.buyerPhone,
      branchName: o.branchName,
      currency: o.currency,
      totalCents: o.totalCents,
      paidCents: o.paidCents,
      balanceCents: o.balanceCents,
    })),
    students,
    branches,
    suggestions: { subjects, classes },
  };

  // Sale balances stay with the Sell section's own table.
  void sales;

  const hero = (
    <section className="relative mb-7 overflow-hidden rounded-[20px] bg-[linear-gradient(135deg,#850019_0%,#6B0014_55%,#5E0012_100%)] p-[22px] text-white shadow-[0_10px_28px_rgba(133,0,25,0.28)] sm:px-8 sm:pb-8 sm:pt-9">
      <div aria-hidden="true" className="absolute -right-10 -top-24 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(245,182,56,0.30),rgba(245,182,56,0)_68%)]" />
      <div className="relative min-w-0">
        <h1 className="text-[28px] font-bold leading-[1.1] tracking-[-0.02em] sm:text-[36px]">Book Management</h1>
        <p className="mt-3 max-w-[60ch] leading-normal text-white/90">Manage academy books, pre-orders, payments and distribution.</p>
      </div>
      <HeroActions can={permissions} />
    </section>
  );

  const compact = (
    <div className="mb-5">
      <h1 className="text-[28px] font-bold leading-tight tracking-[-0.015em]">Book Management</h1>
      <p className="mt-1.5 text-muted">Manage academy books, pre-orders, payments and distribution.</p>
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
