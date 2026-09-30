import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listBookSales } from "@/lib/academies/book-sales";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { BookSalesManager } from "./book-sales-manager";

/** §50-57 — Book Sales history: additional payments and refunds. */
export default async function BookSalesPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const salesResult = await listBookSales(context);
  if (!salesResult.ok) {
    return (
      <PageMessage
        title={salesResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={salesResult.error.message}
      />
    );
  }

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Book sales" description="Sale history, outstanding balances, additional payments, and refunds." />
      <BookSalesManager sales={salesResult.sales} canManage={salesResult.canManage} />
    </div>
  );
}
