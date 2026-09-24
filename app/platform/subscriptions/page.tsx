import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listPlatformSubscriptions } from "@/lib/subscriptions/renew";
import { SubscriptionsManager } from "./subscriptions-manager";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";

const RENEW_CAPABILITY = "renewSubscription";

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
export default async function PlatformSubscriptionsPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, RENEW_CAPABILITY);

  if (!allowed) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  const subscriptions = await listPlatformSubscriptions();

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="Subscriptions" />
      <SubscriptionsManager subscriptions={subscriptions} />
    </div>
  );
}
