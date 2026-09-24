"use client";

import { useState, useTransition } from "react";
import { renewSubscription } from "@/lib/subscriptions/renew-actions";
import type { PlatformSubscriptionRow } from "@/lib/subscriptions/renew";
import { Badge, Button, ErrorMessage, Section, TableWrap, td, th, trHover } from "@/app/academy/_shell/ui";

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

const STATUS_TONE: Record<PlatformSubscriptionRow["effectiveStatus"], "gray" | "blue" | "green" | "amber" | "red"> = {
  draft: "gray",
  trial: "blue",
  active: "green",
  past_due: "amber",
  suspended: "red",
  expired: "red",
  cancelled: "gray",
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
    return (
      <Section>
        <p className="text-sm text-muted">No subscriptions yet.</p>
      </Section>
    );
  }

  return (
    <TableWrap>
      <thead>
        <tr>
          <th className={th}>Academy</th>
          <th className={th}>Plan</th>
          <th className={th}>Status</th>
          <th className={th}>Starts</th>
          <th className={th}>Ends</th>
          <th className={th}>Renewed</th>
          <th className={th}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {subscriptions.map((subscription) => (
          <SubscriptionRow key={subscription.subscriptionId} subscription={subscription} />
        ))}
      </tbody>
    </TableWrap>
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

  return (
    <>
      <tr className={trHover}>
        <td className={`${td} font-medium`}>{subscription.academyName}</td>
        <td className={td}>
          {subscription.planName} ({subscription.billingPeriod})
        </td>
        <td className={td}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge label={STATUS_LABELS[subscription.effectiveStatus]} tone={STATUS_TONE[subscription.effectiveStatus]} />
            {subscription.effectiveStatus === "past_due" && subscription.graceDaysRemaining !== null && (
              <span className="text-xs text-warning">
                {subscription.graceDaysRemaining} day{subscription.graceDaysRemaining === 1 ? "" : "s"} left in grace period
              </span>
            )}
            {subscription.expiringSoon && (
              <span className="text-xs text-warning">
                Expiring in {subscription.expiringSoonDaysRemaining} day
                {subscription.expiringSoonDaysRemaining === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </td>
        <td className={td}>{formatDate(subscription.startsAt)}</td>
        <td className={td}>{formatDate(subscription.endsAt)}</td>
        <td className={td}>{formatDate(subscription.renewedAt)}</td>
        <td className={td}>
          <Button
            type="button"
            variant="secondary"
            className="px-2.5 py-1 text-xs"
            disabled={!subscription.canRenew || isPending}
            title={subscription.renewDisabledReason ?? undefined}
            onClick={handleRenew}
          >
            {isPending ? "Renewing..." : "Renew"}
          </Button>
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={7} className={td}>
            <ErrorMessage message={error} />
          </td>
        </tr>
      )}
    </>
  );
}
