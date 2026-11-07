"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BooksNavFrame, sectionOf, type BooksSection } from "./books-tabs";
import {
  BooksCatalogSkeleton,
  BooksCompactTitle,
  BooksHeroSkeleton,
  CampaignsSkeleton,
  GiveSkeleton,
  NavRightSkeleton,
  OrderDetailSkeleton,
  OrdersSkeleton,
  PaymentsSkeleton,
  ReceivingSkeleton,
  ReportsSkeleton,
  SellSkeleton,
  StockSkeleton,
} from "./books-skeleton";

const SECTION_SKELETON: Record<BooksSection, () => ReactNode> = {
  books: BooksCatalogSkeleton,
  stock: StockSkeleton,
  sell: SellSkeleton,
  campaigns: CampaignsSkeleton,
  orders: OrdersSkeleton,
  payments: PaymentsSkeleton,
  receive: ReceivingSkeleton,
  give: GiveSkeleton,
  reports: ReportsSkeleton,
};

/**
 * First load of any Book Management route: the page as it will appear,
 * for the section being opened. The hero (or, on an order's page, the
 * compact title), the real Books / Orders tabs and section pills with the
 * open one marked, and that section's own skeleton. Reports and the section
 * action are placeholders, since they depend on the member's access.
 */
export function BooksRouteSkeleton() {
  const pathname = usePathname();
  const section = sectionOf(pathname);
  const isOrderPage = /^\/academy\/books\/orders\/[^/]+/.test(pathname);
  const Section = SECTION_SKELETON[section];
  return (
    <div className="text-sm leading-[1.45]">
      {isOrderPage ? <BooksCompactTitle /> : <BooksHeroSkeleton />}
      <BooksNavFrame section={section} right={<NavRightSkeleton />} />
      {isOrderPage ? <OrderDetailSkeleton /> : <Section />}
    </div>
  );
}
