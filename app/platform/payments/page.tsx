import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import {
  listAcademySubscriptionOptions,
  listSubscriptionPayments,
} from "@/lib/subscriptions/payments";
import { PaymentsManager } from "./payments-manager";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { PaginationNav } from "@/components/pagination-nav";
import { parsePageParam } from "@/lib/ui/pagination";

const RECORD_PAYMENT_CAPABILITY = "recordSubscriptionPayment";
const VERIFY_PAYMENT_CAPABILITY = "verifySubscriptionPayment";
const PAGE_SIZE = 15;

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
  const [allPayments, subscriptionOptions] = await Promise.all([
    listSubscriptionPayments(),
    listAcademySubscriptionOptions(),
  ]);
  // `listSubscriptionPayments()` has no other internal caller today, but
  // sliced here (after fetching) rather than changed at the DB-query level
  // anyway, for the same reason and the same shape as every other platform
  // list page in this pass (see app/platform/academies/page.tsx) — still
  // fully server-side, no client-side fetch-all.
  const totalCount = allPayments.length;
  const offset = (page - 1) * PAGE_SIZE;
  const payments = allPayments.slice(offset, offset + PAGE_SIZE);

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Subscription payments"
        description="Record incoming subscription payments and, if you're the platform owner, verify, reject, or reverse them."
      />
      <PaymentsManager
        payments={payments}
        subscriptionOptions={subscriptionOptions}
        canVerify={canVerify}
      />
      <PaginationNav page={page} pageSize={PAGE_SIZE} totalCount={totalCount} searchParams={params} />
    </div>
  );
}
