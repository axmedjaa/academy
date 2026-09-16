import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import {
  listAcademySubscriptionOptions,
  listSubscriptionPayments,
} from "@/lib/subscriptions/payments";
import { PaymentsManager } from "./payments-manager";

const RECORD_PAYMENT_CAPABILITY = "recordSubscriptionPayment";
const VERIFY_PAYMENT_CAPABILITY = "verifySubscriptionPayment";

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
export default async function PlatformPaymentsPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const canRecord = await hasPermission(context, RECORD_PAYMENT_CAPABILITY);

  if (!canRecord) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to view this page.</p>
      </main>
    );
  }

  const canVerify = await hasPermission(context, VERIFY_PAYMENT_CAPABILITY);
  const [payments, subscriptionOptions] = await Promise.all([
    listSubscriptionPayments(),
    listAcademySubscriptionOptions(),
  ]);

  return (
    <main
      style={{
        maxWidth: 1000,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Subscription payments</h1>
      <PaymentsManager
        payments={payments}
        subscriptionOptions={subscriptionOptions}
        canVerify={canVerify}
      />
    </main>
  );
}
