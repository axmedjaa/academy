import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getSubscriptionPaymentFilterOptions,
  listAcademySubscriptionOptions,
  listFilteredSubscriptionPaymentsPage,
  parsePaymentFilters,
} from "@/lib/subscriptions/payments";
import { PaymentsManager } from "./payments-manager";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { NoteBlock } from "@/app/academy/_shell/page-blocks";
import { PaginationNav } from "@/components/pagination-nav";
import { LIST_PAGE_SIZE_MAX, parsePageParam } from "@/lib/ui/pagination";

const RECORD_PAYMENT_CAPABILITY = "recordSubscriptionPayment";
const VERIFY_PAYMENT_CAPABILITY = "verifySubscriptionPayment";
const PAGE_SIZE = LIST_PAGE_SIZE_MAX;

// PLAN.md Item 25 / DESIGN.md §8: "/platform/payments... grantable to
// platform_admin [for recording]. Row actions: Verify / Reject / Reverse...
// platform_owner-only, never grantable... a platform_admin granted the
// record-payment capability sees the form but no Verify/Reject/Reverse
// buttons on any row." Gated like app/platform/plans/page.tsx: the page
// itself is reachable for platform_owner (always) or a platform_admin
// granted "recordSubscriptionPayment"; a second, separate hasPermission()
// check for "verifySubscriptionPayment" (in UNGRANTABLE_CAPABILITIES, so
// only ever true for platform_owner) decides whether the row actions render
// at all, passed down as a prop rather than re-checked client-side.
export default async function PlatformPaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const canRecord = await hasPermission(context, RECORD_PAYMENT_CAPABILITY);

  if (!canRecord) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  const canVerify = await hasPermission(context, VERIFY_PAYMENT_CAPABILITY);
  const params = await searchParams;
  const page = parsePageParam(params);
  // Perf investigation (Afoogy slow-dashboard task): previously
  // listSubscriptionPayments() (every row, no DB-level LIMIT/OFFSET) then
  // sliced the already-fetched array in JS — harmless at this table's
  // current 29 rows, but the same unbounded-SELECT pattern as
  // /platform/plans (see that page's own fix). listSubscriptionPaymentsPage()
  // pushes LIMIT/OFFSET, the newest-first ordering, and the page-nav total
  // down to Postgres instead; listSubscriptionPayments() itself is
  // untouched for its other caller (this file's own test).
  // Perf investigation (Afoogy slow-dashboard task): `listAcademySubscriptionOptions()`
  // backs this form's plain, unsearchable academy/subscription <select> —
  // with no `limit`, it fetched (and the page then rendered as literal
  // <option> elements) every academy_subscriptions row ever created,
  // platform-wide: harmless at a handful of real academies, but a
  // multi-second, full-table-plus-two-joins query once that table holds
  // thousands of rows. The picker was never designed to show thousands of
  // options anyway — capping it is a query-cost fix, not a feature change.
  const RECORD_PAYMENT_PICKER_LIMIT = 200;
  // Design P07 filter bar: search, status, method, academy and month, all
  // URL params applied in SQL so paging stays server-side.
  const filters = parsePaymentFilters(params);
  const [{ payments, totalCount, overallCount, verifiedTotals }, subscriptionOptions, filterOptions] = await Promise.all([
    listFilteredSubscriptionPaymentsPage(filters, page, PAGE_SIZE),
    listAcademySubscriptionOptions({ limit: RECORD_PAYMENT_PICKER_LIMIT }),
    getSubscriptionPaymentFilterOptions(),
  ]);
  // Academy names for this page's rows (the picker is capped, so look the
  // page's own subscriptions up rather than relying on it).
  const pageOptions =
    payments.length > 0
      ? await listAcademySubscriptionOptions({ subscriptionIds: [...new Set(payments.map((payment) => payment.subscriptionId))] })
      : [];
  const academyNames = Object.fromEntries(pageOptions.map((option) => [option.academyId, option.academyName]));
  const first = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(totalCount, page * PAGE_SIZE);

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Payments" description="Subscription payments recorded for academies." />
      <PaymentsManager
        payments={payments}
        academyNames={academyNames}
        subscriptionOptions={subscriptionOptions}
        canVerify={canVerify}
        filterOptions={filterOptions}
        filtersActive={Object.keys(filters).length > 0}
        matchingCount={totalCount}
        overallCount={overallCount}
        verifiedTotals={verifiedTotals}
      />
      <PaginationNav page={page} pageSize={PAGE_SIZE} totalCount={totalCount} searchParams={params} showTotal={false} />
      {totalCount > 0 && (
        <NoteBlock>
          Rows {first}–{last} of {totalCount.toLocaleString("en-US")}. Reversing a payment marks the same row Reversed; no linked record is created.
          {canVerify ? "" : " Verifying, rejecting and reversing are done by the platform owner."}
        </NoteBlock>
      )}
    </div>
  );
}
