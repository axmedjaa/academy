import { redirect } from "next/navigation";

/**
 * Navigation-audit Phase 1 — `/academy/reports?tab=finance` is now the
 * canonical destination for finance reports (see that route's own module
 * comment in app/academy/reports/page.tsx). This route is kept as a
 * compatibility redirect rather than deleted, so any existing bookmark or
 * external link to `/academy/finance-reports` still lands somewhere
 * correct instead of 404ing.
 *
 * Deliberately NOT re-implemented as a page that calls `getFinanceReports`
 * and renders `FinanceReportsView` itself — that would just be the same
 * duplication this redirect exists to remove. The underlying report
 * function, the `FinanceReportsView` component, and `/academy/reports`'s
 * own `FinanceTab` (which calls both, unchanged) are untouched by this
 * file; only this page's own body changed from "render the report" to
 * "redirect to the one place that renders the report."
 *
 * No auth check here: `redirect()` runs before any render, and the target
 * route (`/academy/reports`) performs its own full `getAuthContext` +
 * permission check exactly as before — this file would only ever add a
 * second, redundant gate in front of the same destination.
 */
export default function AcademyFinanceReportsRedirectPage() {
  redirect("/academy/reports?tab=finance");
}
