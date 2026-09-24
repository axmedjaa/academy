import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getFinanceReports } from "@/lib/academies/finance-reports";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { FinanceReportsView } from "./finance-reports-view";

/**
 * PLAN.md Phase 4, Item 55 — Finance Reports (DESIGN.md §9.6: "Custom +
 * export | Date/branch/status/method filters. Never shows a
 * subscription-payment row — this view is exclusively student/academy-side
 * money; platform SaaS billing has no presence here at all.").
 *
 * A separate route from `/academy/finance` (that page's own module comment
 * explicitly defers "reports" to this item, and the task brief asks for a
 * new file here rather than editing that page, to avoid conflicting with
 * concurrent work on it).
 *
 * Same gating shape as app/academy/finance/page.tsx: this page repeats its
 * own `getFinanceReports` call (which itself resolves
 * `checkAcademyAccessForContext`) rather than relying on a shared
 * layout-level resolution channel that doesn't exist. `getFinanceReports`
 * only ever fails outright (`ok: false`) for a whole-report reason (not
 * signed in / not a member / suspended academy / etc., or bad filter
 * input) — per-entity visibility (Trainer sees payments+expenses but not
 * income, say) is expressed inside a successful result's own
 * `studentPayments`/`income`/`expenses` sections instead, each independently
 * `{ visible: false }` or `{ visible: true, ... }` — so this page only
 * renders a top-level error for the whole-report failure case, and lets
 * `FinanceReportsView` render each section (or its absence) from the
 * successful result.
 */
export default async function AcademyFinanceReportsPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const result = await getFinanceReports(context, {});

  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Finance Reports"
        description="Outstanding charges, payments received, income vs. expenses, and pending approvals for this academy. This view never includes platform subscription billing — only student and academy-side money."
      />
      <FinanceReportsView initialReport={result.report} />
    </div>
  );
}
