import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listPlatformSubscriptionsPage } from "@/lib/subscriptions/renew";
import { SubscriptionsManager } from "./subscriptions-manager";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { PaginationNav } from "@/components/pagination-nav";
import { LIST_PAGE_SIZE_MAX, parsePageParam } from "@/lib/ui/pagination";

const RENEW_CAPABILITY = "renewSubscription";
const PAGE_SIZE = LIST_PAGE_SIZE_MAX;

/** The time this request is rendered at (terms are counted from it). */
function requestTime(): number {
  return Date.now();
}

// PLAN.md Item 30 / DESIGN.md §8: "/platform/subscriptions | A | ... Renew
// is platform_owner-only and absent for every platform_admin (§5)." Unlike
// /platform/payments (which has a separate, grantable "record payment"
// capability that lets a platform_admin reach the page at all), PLAN.md's
// Master Permission Matrix names no grantable capability that covers
// *viewing* /platform/subscriptions — the only capability this whole
// screen is built around, `renewSubscription`, is itself in
// UNGRANTABLE_CAPABILITIES (platform_owner only, no matter what a
// platform_admin has been granted). So, matching app/platform/staff/
// page.tsx's and app/platform/plans/page.tsx's pattern for pages with no
// separate lesser view capability, the whole page is gated on that one
// capability rather than inventing a new, unlisted "view subscriptions"
// capability hasPermission() wouldn't know about — a platform_admin never
// satisfies it, so the page (and its nav entry, once a shell adds one) is
// absent for them exactly as DESIGN.md §5 requires.
export default async function PlatformSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, RENEW_CAPABILITY);

  if (!allowed) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  // Perf investigation (Afoogy slow-dashboard task): previously called
  // listPlatformSubscriptions() (every row, plus its own eligible-payment
  // lookup for every one of them) and sliced the already-fetched array in
  // JS. listPlatformSubscriptionsPage() pushes LIMIT/OFFSET and the
  // page-nav total down to Postgres, and scopes the eligible-payment
  // lookup to just this page's rows. listPlatformSubscriptions() itself
  // is untouched — lib/subscriptions/expiry-reminder-job.ts still needs
  // every row, never one page of them.
  const params = await searchParams;
  const page = parsePageParam(params);
  const { subscriptions, totalCount } = await listPlatformSubscriptionsPage(page, PAGE_SIZE);

  const from = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, totalCount);

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Subscriptions" description="Subscription state and renewals for every academy." />
      <SubscriptionsManager subscriptions={subscriptions} now={requestTime()} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">{totalCount > 0 ? `Showing ${from}–${to} of ${totalCount.toLocaleString("en-US")}` : ""}</p>
        <PaginationNav page={page} pageSize={PAGE_SIZE} totalCount={totalCount} searchParams={params} showTotal={false} />
      </div>
      {/* Design P05: a plain grey note under the list, not a callout. */}
      <p className="mb-8 text-[13px] text-muted">
        Renew extends the term by one billing period from the later of the current end date and today. It needs a verified,
        unused payment.
      </p>
    </div>
  );
}
