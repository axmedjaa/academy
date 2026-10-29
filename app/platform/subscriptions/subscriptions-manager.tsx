"use client";

import Link from "next/link";
import { renewSubscription } from "@/lib/subscriptions/renew-actions";
import type { PlatformSubscriptionRow } from "@/lib/subscriptions/renew";
import { formatDate } from "@/lib/ui/date";
import { Badge, Button, EmptyState, Section } from "@/app/academy/_shell/ui";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import { Icon } from "@/app/academy/_shell/icons";
import { subscriptionLabel, subscriptionTone } from "../_shared/status";

const DAY_MS = 24 * 60 * 60 * 1000;

/** "41 days left", "Ends today", "Ended 3 days ago", "Not started". */
function termLabel(subscription: PlatformSubscriptionRow, now: number): string {
  if (subscription.effectiveStatus === "draft") return "Not started";
  if (!subscription.endsAt) return "No end date";
  const days = Math.ceil((new Date(subscription.endsAt).getTime() - now) / DAY_MS);
  if (days > 1) return `${days} days left`;
  if (days === 1) return "1 day left";
  if (days === 0) return "Ends today";
  return `Ended ${-days} day${days === -1 ? "" : "s"} ago`;
}

/**
 * Subscriptions (design P05): one card per academy subscription with its
 * plan, status and remaining term, and Renew. Renew is the existing
 * owner-only action behind a confirmation; when it is not available the
 * reason is shown as text under the button (the server's own wording),
 * not only as a hover tooltip.
 */
export function SubscriptionsManager({ subscriptions, now }: { subscriptions: PlatformSubscriptionRow[]; now: number }) {
  if (subscriptions.length === 0) {
    return (
      <Section className="mb-8">
        <EmptyState message="No subscriptions yet. Registering an academy creates its first subscription." icon={<Icon name="autorenew" />} />
      </Section>
    );
  }

  return (
    <ul role="list" className="mb-4 flex flex-col gap-3.5">
      {subscriptions.map((subscription) => (
        <li key={subscription.subscriptionId} className="@container rounded-card border border-border bg-surface px-5 py-4 shadow-card">
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 @[480px]:grid-cols-[minmax(0,1.6fr)_minmax(96px,auto)_minmax(96px,auto)] @[760px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1.5fr)_minmax(96px,auto)_minmax(96px,auto)_minmax(170px,1fr)] @[760px]:items-center">
            <div className="col-span-full min-w-0 @[760px]:col-span-1">
              <Link
                href={`/platform/academies/${subscription.academyId}`}
                className="font-semibold !text-ink no-underline [overflow-wrap:anywhere] hover:!text-brand hover:underline"
              >
                {subscription.academyName}
              </Link>
              <span className="mt-0.5 block text-xs text-muted">
                Started {formatDate(subscription.startsAt)}
                {subscription.renewedAt ? ` · renewed ${formatDate(subscription.renewedAt)}` : ""}
              </span>
            </div>
            <div className="col-span-2 min-w-0 @[480px]:col-span-1">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Plan</span>
              <span className="block text-ink [overflow-wrap:anywhere]">{subscription.planName}</span>
              <span className="block text-xs capitalize text-muted">{subscription.billingPeriod}</span>
            </div>
            <div className="min-w-0">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Status</span>
              <Badge label={subscriptionLabel(subscription.effectiveStatus)} tone={subscriptionTone(subscription.effectiveStatus)} />
              {subscription.effectiveStatus === "past_due" && subscription.graceDaysRemaining !== null && (
                <span className="mt-0.5 block text-xs text-warning">
                  {subscription.graceDaysRemaining} day{subscription.graceDaysRemaining === 1 ? "" : "s"} left in grace
                </span>
              )}
            </div>
            <div className="min-w-0">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Term</span>
              <span className={`block ${subscription.expiringSoon ? "font-semibold text-warning" : "text-ink"}`}>{termLabel(subscription, now)}</span>
              {subscription.endsAt && <span className="block text-xs text-muted">Ends {formatDate(subscription.endsAt)}</span>}
            </div>
            <div className="col-span-full min-w-0 @[760px]:col-span-1">
              {subscription.canRenew ? (
                <ConfirmButton
                  label="Renew"
                  variant="primary"
                  title={`Renew the subscription for ${subscription.academyName}?`}
                  description={`This extends the term by one ${subscription.billingPeriod} billing period and uses one verified, unused payment.`}
                  onConfirm={() => renewSubscription(subscription.subscriptionId)}
                />
              ) : (
                <Button type="button" disabled aria-describedby={`renew-why-${subscription.subscriptionId}`}>
                  Renew
                </Button>
              )}
              <span id={`renew-why-${subscription.subscriptionId}`} className="mt-1 block text-xs text-muted">
                {subscription.canRenew ? "Uses its verified payment." : (subscription.renewDisabledReason ?? "Renew is not available.")}
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
