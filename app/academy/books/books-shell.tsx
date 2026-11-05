import type { ReactNode } from "react";
import type { BookRecord } from "@/lib/academies/books";
import type { BookSaleListRow } from "@/lib/academies/book-sales";
import type { PreorderBranchOption, PreorderOverview, PreorderStudentOption } from "@/lib/academies/book-preorders";
import { BooksActionsProvider, ActionButton, type BooksClientData } from "./books-actions";
import { BooksStageNav, HeroGate, type NavPermissions, type StageCounts } from "./books-tabs";
import { plural, sumByCurrency } from "./books-view";

/**
 * Book Management header (design B01-B09): the burgundy hero with the main
 * actions and pre-order totals, the four-step roadmap and the section tabs.
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
  const fallback = books[0]?.currency ?? "USD";
  const copiesOrdered = orders.reduce((sum, o) => sum + o.copies, 0);
  const toGive = orders.reduce((sum, o) => sum + (o.copies - o.given), 0);
  const owing = orders.filter((o) => o.balanceCents > 0);
  const payments = orders.flatMap((o) => o.payments.map((p) => ({ ...p, currency: o.currency })));
  const toVerify = payments.filter((p) => !p.verified);

  const counts: StageCounts = {
    activeBooks: books.filter((b) => b.status === "active").length,
    copiesInStock: books.filter((b) => b.status === "active").reduce((sum, b) => sum + b.stockQuantity, 0),
    openCampaigns: campaigns.filter((c) => c.status === "open").length,
    orders: orders.length,
    payments: payments.length,
    toVerify: toVerify.length,
    toReceive: campaigns.reduce((sum, c) => sum + c.books.reduce((s, b) => s + Math.max(0, b.ordered - b.usable), 0), 0),
    toGive,
  };

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

  const campaignsWithOrders = new Set(orders.map((o) => o.campaignId)).size;
  const tiles = [
    { label: "Payments collected", value: sumByCurrency(orders.map((o) => ({ cents: o.paidCents, currency: o.currency })), fallback), hint: `${sumByCurrency(toVerify.map((p) => ({ cents: p.amountCents, currency: p.currency })), fallback)} waiting for verification` },
    { label: "Outstanding payments", value: sumByCurrency(owing.map((o) => ({ cents: o.balanceCents, currency: o.currency })), fallback), hint: `${plural(owing.length, "order", "orders")} with a balance` },
    { label: "Books ordered", value: String(copiesOrdered), hint: "Copies across all campaigns" },
    { label: "Waiting to be given", value: String(toGive), hint: "Copies not yet given" },
  ];
  // Sale balances stay with the Sell Book section's own table.
  void sales;

  const hero = (
    <section className="relative mb-6 overflow-hidden rounded-[20px] bg-[linear-gradient(135deg,#850019_0%,#5E0012_100%)] p-[22px] text-white shadow-[0_10px_28px_rgba(133,0,25,0.28)] sm:p-8">
      <div aria-hidden="true" className="absolute -right-[70px] -top-[90px] h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(245,182,56,0.38),rgba(245,182,56,0)_68%)]" />
      <div aria-hidden="true" className="absolute -bottom-[140px] -left-[90px] h-[360px] w-[360px] rounded-full bg-[radial-gradient(circle,rgba(255,255,255,0.10),rgba(255,255,255,0)_70%)]" />
      <div className="relative flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0 flex-[1_1_320px]">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-brand-tint">
            <span className="h-2 w-2 rounded-full bg-[#F5B638]" />
            Academy books
          </div>
          <h1 className="mt-2.5 text-[28px] font-bold leading-[1.1] tracking-[-0.02em] sm:text-4xl">Book Management</h1>
          <p className="mt-2.5 max-w-[56ch] leading-normal text-brand-tint">Manage academy books, pre-orders, payments and distribution.</p>
          <div className="mt-5 flex flex-wrap gap-3">
            {permissions.canManageBooks && (
              <ActionButton dialog={{ kind: "addBook" }} variant="gold" className="h-12 rounded-[10px] px-[22px]">
                Add Book
              </ActionButton>
            )}
            {permissions.canSell && (
              <ActionButton dialog={{ kind: "sell" }} variant="ghost-light" className="h-12 rounded-[10px] px-5">
                Sell Book
              </ActionButton>
            )}
            {permissions.canManageCampaigns && (
              <ActionButton dialog={{ kind: "campaign" }} variant="ghost-light" className="h-12 rounded-[10px] px-5">
                Create Pre-Order Campaign
              </ActionButton>
            )}
          </div>
        </div>
        <div className="min-w-0 flex-none">
          <div className="text-[13px] font-semibold text-brand-tint">Student orders</div>
          <div className="mt-1 text-[56px] font-bold leading-none tracking-[-0.03em] tabular-nums sm:text-[72px]">{orders.length}</div>
          <div className="mt-2 max-w-[240px] text-[13px] text-brand-tint">Across {plural(campaignsWithOrders, "campaign", "campaigns")}</div>
        </div>
      </div>
      <div className="relative mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="min-w-0 rounded-[14px] border border-white/20 bg-white/[0.12] px-4 py-3.5">
            <div className="text-xs font-medium text-brand-tint">{t.label}</div>
            <div className="mt-1 text-xl font-bold tracking-[-0.01em] tabular-nums [overflow-wrap:anywhere] sm:text-2xl">{t.value}</div>
            <div className="mt-0.5 text-xs text-brand-tint">{t.hint}</div>
          </div>
        ))}
      </div>
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
        <BooksStageNav counts={counts} can={permissions} />
        {children}
      </div>
    </BooksActionsProvider>
  );
}
