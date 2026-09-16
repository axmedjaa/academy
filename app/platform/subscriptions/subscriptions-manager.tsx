"use client";

import { useState, useTransition } from "react";
import { renewSubscription } from "@/lib/subscriptions/renew-actions";
import type { PlatformSubscriptionRow } from "@/lib/subscriptions/renew";

interface Props {
  subscriptions: PlatformSubscriptionRow[];
}

const STATUS_LABELS: Record<PlatformSubscriptionRow["effectiveStatus"], string> = {
  draft: "Draft",
  trial: "Trial",
  active: "Active",
  past_due: "Past Due",
  suspended: "Suspended",
  expired: "Expired",
  cancelled: "Cancelled",
};

function formatDate(date: Date | null): string {
  return date ? new Date(date).toLocaleDateString() : "—";
}

// DESIGN.md §8: "/platform/subscriptions | A | Status badge shows the
// derived label including grace-period countdown (§11.1) and an
// 'Expiring in N days' amber flag near ends_at. Row action: Renew —
// disabled with a tooltip if no verified payment exists for that
// subscription yet (§11.5); never offered on a Cancelled subscription...
// Renew is platform_owner-only and absent for every platform_admin (§5)."
// This page is only ever reached by a platform_owner in the first place
// (see app/platform/subscriptions/page.tsx's gating comment), so there is
// no separate "canRenew prop toggling the whole action column" the way
// app/platform/payments/payments-manager.tsx needs one for a
// platform_admin viewer — the disabled/tooltip state is purely per-row,
// driven by `renewDisabledReason` from lib/subscriptions/renew.ts's
// listPlatformSubscriptions.
export function SubscriptionsManager({ subscriptions }: Props) {
  if (subscriptions.length === 0) {
    return <p>No subscriptions yet.</p>;
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={{ textAlign: "left" }}>Academy</th>
          <th style={{ textAlign: "left" }}>Plan</th>
          <th style={{ textAlign: "left" }}>Status</th>
          <th style={{ textAlign: "left" }}>Starts</th>
          <th style={{ textAlign: "left" }}>Ends</th>
          <th style={{ textAlign: "left" }}>Renewed</th>
          <th style={{ textAlign: "left" }}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {subscriptions.map((subscription) => (
          <SubscriptionRow key={subscription.subscriptionId} subscription={subscription} />
        ))}
      </tbody>
    </table>
  );
}

function SubscriptionRow({ subscription }: { subscription: PlatformSubscriptionRow }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleRenew() {
    const confirmed = window.confirm(
      `Renew the subscription for ${subscription.academyName}? This will extend ends_at by one ${subscription.billingPeriod} billing period and consume one verified payment.`,
    );
    if (!confirmed) return;

    setError(null);
    startTransition(async () => {
      const result = await renewSubscription(subscription.subscriptionId);
      if (!result.ok) {
        setError(result.error.message);
      }
    });
  }

  let statusBadge = STATUS_LABELS[subscription.effectiveStatus];
  if (subscription.effectiveStatus === "past_due" && subscription.graceDaysRemaining !== null) {
    statusBadge += ` — ${subscription.graceDaysRemaining} day${
      subscription.graceDaysRemaining === 1 ? "" : "s"
    } left in grace period`;
  }

  return (
    <>
      <tr>
        <td>{subscription.academyName}</td>
        <td>
          {subscription.planName} ({subscription.billingPeriod})
        </td>
        <td>
          {statusBadge}
          {subscription.expiringSoon && (
            <span style={{ color: "#b45309", marginLeft: "0.5rem" }}>
              Expiring in {subscription.expiringSoonDaysRemaining} day
              {subscription.expiringSoonDaysRemaining === 1 ? "" : "s"}
            </span>
          )}
        </td>
        <td>{formatDate(subscription.startsAt)}</td>
        <td>{formatDate(subscription.endsAt)}</td>
        <td>{formatDate(subscription.renewedAt)}</td>
        <td>
          <button
            type="button"
            disabled={!subscription.canRenew || isPending}
            title={subscription.renewDisabledReason ?? undefined}
            onClick={handleRenew}
          >
            {isPending ? "Renewing..." : "Renew"}
          </button>
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={7} role="alert" style={{ color: "crimson" }}>
            {error}
          </td>
        </tr>
      )}
    </>
  );
}
