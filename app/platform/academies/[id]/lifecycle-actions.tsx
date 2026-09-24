"use client";

import { useState, useTransition } from "react";
import {
  activateAcademyAction,
  cancelAcademyAction,
  closeAcademyAction,
  reactivateAcademyAction,
  suspendAcademyAction,
  type LifecycleActionResult,
} from "@/lib/academies/lifecycle-actions";
import type { SubscriptionStatus } from "@/lib/subscriptions/state-machine";
import { Button, ErrorMessage, inputClass } from "@/app/academy/_shell/ui";

interface LifecycleActionsProps {
  academyId: string;
  /**
   * The *raw stored* academy_subscriptions.status (not the lazily-computed
   * effective status shown elsewhere) — lib/academies/lifecycle.ts's
   * activateAcademy/suspendAcademy/etc. all validate transitions against
   * this literal stored value (transitionSubscriptionState(subscription.status,
   * event)), so gating each button on the same raw value is what keeps
   * "enabled" synonymous with "the server call will not reject this for an
   * invalid-transition reason" — the same never-clickable-but-failing
   * standard DESIGN.md §11.3 sets for the Activate button specifically,
   * extended here to every lifecycle button for consistency. Null when the
   * academy has no academy_subscriptions row at all.
   */
  subscriptionStatus: SubscriptionStatus | null;
  checklistSatisfied: boolean;
  checklistUnmetReasons: string[];
  academyClosed: boolean;
}

const ACTIVATE_SOURCES: ReadonlySet<SubscriptionStatus> = new Set(["draft", "trial"]);
const SUSPEND_SOURCES: ReadonlySet<SubscriptionStatus> = new Set(["active", "trial", "past_due"]);
const REACTIVATE_SOURCES: ReadonlySet<SubscriptionStatus> = new Set(["suspended"]);
const CANCEL_SOURCES: ReadonlySet<SubscriptionStatus> = new Set([
  "draft",
  "trial",
  "active",
  "past_due",
  "suspended",
  "expired",
]);

function StatusMessage({ error, success }: { error: string | null; success: string | null }) {
  if (error) {
    return (
      <div className="mt-2">
        <ErrorMessage message={error} />
      </div>
    );
  }
  if (success) {
    return <p className="mt-2 text-sm font-medium text-success">{success}</p>;
  }
  return null;
}

/**
 * One lifecycle action's UI: a button, an optional reason field (required or
 * optional per `reasonMode`), and its own pending/error/success state. Kept
 * generic and reused for Suspend/Reactivate/Cancel/Close rather than
 * duplicating four near-identical forms — Activate has no reason field at
 * all, so it's a separate, simpler component below.
 */
function ReasonAction({
  label,
  pendingLabel,
  reasonMode,
  disabled,
  disabledReason,
  confirmLabel,
  onSubmit,
  variant = "secondary",
}: {
  label: string;
  pendingLabel: string;
  reasonMode: "required" | "optional";
  disabled: boolean;
  disabledReason?: string;
  /** When set, a confirmation checkbox must be ticked before submitting (Close). */
  confirmLabel?: string;
  onSubmit: (reason: string | undefined) => Promise<LifecycleActionResult>;
  variant?: "secondary" | "danger";
}) {
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reasonMissing = reasonMode === "required" && reason.trim().length === 0;
  const confirmMissing = Boolean(confirmLabel) && !confirmed;
  const submitDisabled = disabled || isPending || reasonMissing || confirmMissing;

  function handleSubmit() {
    setError(null);
    startTransition(async () => {
      const result = await onSubmit(reason.trim().length > 0 ? reason.trim() : undefined);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSuccess(`${label} succeeded.`);
    });
  }

  return (
    <div className="rounded-card border border-border bg-surface p-4" title={disabled ? disabledReason : undefined}>
      <strong className="text-sm font-semibold text-ink">{label}</strong>
      <div className="mt-2">
        <input
          type="text"
          placeholder={reasonMode === "required" ? "Reason (required)" : "Reason (optional)"}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={disabled || isPending}
          className={`${inputClass} max-w-md`}
        />
      </div>
      {confirmLabel && (
        <label className="mt-2 flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={disabled || isPending}
            className="mt-0.5"
          />
          {confirmLabel}
        </label>
      )}
      <div className="mt-3">
        <Button type="button" variant={variant} onClick={handleSubmit} disabled={submitDisabled} title={disabled ? disabledReason : undefined}>
          {isPending ? pendingLabel : label}
        </Button>
      </div>
      {disabled && disabledReason && <p className="mt-2 text-xs text-muted">{disabledReason}</p>}
      <StatusMessage error={error} success={success} />
    </div>
  );
}

/**
 * Wires PLAN.md Item 26's five lifecycle actions
 * (activate/suspend/reactivate/cancel/close) into
 * /platform/academies/[id]. Deliberately no Renew button — DESIGN.md and
 * lib/academies/access-gate.ts both establish that Renew (verified-payment
 * reactivation of a lapsed subscription) lives on /platform/subscriptions
 * (Item 30's page, not this one's scope).
 */
export function LifecycleActions({
  academyId,
  subscriptionStatus,
  checklistSatisfied,
  checklistUnmetReasons,
  academyClosed,
}: LifecycleActionsProps) {
  const [activateError, setActivateError] = useState<string | null>(null);
  const [activateSuccess, setActivateSuccess] = useState<string | null>(null);
  const [isActivatePending, startActivateTransition] = useTransition();

  if (academyClosed) {
    return <p className="text-sm text-muted">This academy is permanently closed — no lifecycle actions are available.</p>;
  }

  if (subscriptionStatus === null) {
    return (
      <p className="text-sm text-muted">
        This academy has no subscription yet — lifecycle actions become available once one is created.
      </p>
    );
  }

  const activateStatusReasons = !ACTIVATE_SOURCES.has(subscriptionStatus)
    ? [`Cannot activate a subscription in status "${subscriptionStatus}".`]
    : [];
  const activateDisabledReasons = [...checklistUnmetReasons, ...activateStatusReasons];
  // Trust checklistSatisfied (not just "is the reasons list empty") as the
  // checklist half of this condition — it's the single source of truth
  // getOnboardingChecklistStatus computes, so this button can never disagree
  // with the widget rendered just above it on the page.
  const activateDisabled = !checklistSatisfied || activateStatusReasons.length > 0;

  function handleActivate() {
    setActivateError(null);
    startActivateTransition(async () => {
      const result = await activateAcademyAction(academyId);
      if (!result.ok) {
        setActivateError(result.error.message);
        return;
      }
      setActivateSuccess("Academy activated.");
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className="rounded-card border border-border bg-surface p-4"
        title={activateDisabled ? activateDisabledReasons.join(" ") : undefined}
      >
        <strong className="text-sm font-semibold text-ink">Activate</strong>
        <div className="mt-3">
          <Button
            type="button"
            onClick={handleActivate}
            disabled={activateDisabled || isActivatePending}
            title={activateDisabled ? activateDisabledReasons.join(" ") : undefined}
          >
            {isActivatePending ? "Activating..." : "Activate"}
          </Button>
        </div>
        {activateDisabled && (
          <ul className="mt-2 list-disc pl-5 text-xs text-muted">
            {activateDisabledReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        <StatusMessage error={activateError} success={activateSuccess} />
      </div>

      <ReasonAction
        label="Suspend"
        pendingLabel="Suspending..."
        reasonMode="required"
        disabled={!SUSPEND_SOURCES.has(subscriptionStatus)}
        disabledReason={
          !SUSPEND_SOURCES.has(subscriptionStatus)
            ? `Cannot suspend a subscription in status "${subscriptionStatus}".`
            : undefined
        }
        variant="danger"
        onSubmit={(reason) => suspendAcademyAction(academyId, reason ?? "")}
      />

      <ReasonAction
        label="Reactivate"
        pendingLabel="Reactivating..."
        reasonMode="optional"
        disabled={!REACTIVATE_SOURCES.has(subscriptionStatus)}
        disabledReason={
          !REACTIVATE_SOURCES.has(subscriptionStatus)
            ? `Cannot reactivate a subscription in status "${subscriptionStatus}". If this subscription lapsed for non-payment, use Renew on /platform/subscriptions instead.`
            : undefined
        }
        onSubmit={(reason) => reactivateAcademyAction(academyId, reason)}
      />

      <ReasonAction
        label="Cancel"
        pendingLabel="Cancelling..."
        reasonMode="required"
        disabled={!CANCEL_SOURCES.has(subscriptionStatus)}
        disabledReason={
          !CANCEL_SOURCES.has(subscriptionStatus)
            ? `Cannot cancel a subscription in status "${subscriptionStatus}".`
            : undefined
        }
        variant="danger"
        onSubmit={(reason) => cancelAcademyAction(academyId, reason ?? "")}
      />

      <ReasonAction
        label="Close academy"
        pendingLabel="Closing..."
        reasonMode="required"
        disabled={false}
        confirmLabel="I understand this is permanent and cannot be undone."
        variant="danger"
        onSubmit={(reason) => closeAcademyAction(academyId, reason ?? "")}
      />
    </div>
  );
}
