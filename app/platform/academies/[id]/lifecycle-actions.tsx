"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  activateAcademyAction,
  cancelAcademyAction,
  closeAcademyAction,
  reactivateAcademyAction,
  suspendAcademyAction,
  type LifecycleActionResult,
} from "@/lib/academies/lifecycle-actions";
import type { SubscriptionStatus } from "@/lib/subscriptions/state-machine";
import { showSuccessToast } from "@/lib/ui/toast";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import { ROW_BTN, ROW_BTN_DANGER } from "@/app/academy/_shell/page-blocks";
import { ActionDialog, DField, ReasonField, controlClass, invalidProps, type DesignFormRule } from "@/app/academy/_shell/design-form";

interface LifecycleActionsProps {
  academyId: string;
  academyName: string;
  /** The stored (not lazily computed) status: the server's transition
   * rules check the stored value, so the buttons offered follow it too. */
  subscriptionStatus: SubscriptionStatus | null;
  checklistSatisfied: boolean;
  checklistUnmetReasons: string[];
  academyClosed: boolean;
}

const ACTIVATE_SOURCES: ReadonlySet<SubscriptionStatus> = new Set(["draft", "trial"]);
const SUSPEND_SOURCES: ReadonlySet<SubscriptionStatus> = new Set(["active", "trial", "past_due"]);
const REACTIVATE_SOURCES: ReadonlySet<SubscriptionStatus> = new Set(["suspended"]);
const CANCEL_SOURCES: ReadonlySet<SubscriptionStatus> = new Set(["draft", "trial", "active", "past_due", "suspended", "expired"]);

type Kind = "suspend" | "reactivate" | "cancel" | "close";

const REQUIRED_REASON: DesignFormRule[] = [{ name: "reason", label: "Reason", required: true }];
const CLOSE_RULES: DesignFormRule[] = [
  ...REQUIRED_REASON,
  { name: "confirm", label: "Confirmation", check: (value) => (value === "yes" ? null : "Tick the box to confirm.") },
];

const COPY: Record<Kind, { label: string; hint: string; title: string; description: string; danger: boolean; rules: DesignFormRule[]; done: string }> = {
  suspend: {
    label: "Suspend",
    hint: "Blocks sign-in. Reason required.",
    title: "Suspend this academy?",
    description: "Everyone in the academy is blocked from signing in until it is reactivated.",
    danger: true,
    rules: REQUIRED_REASON,
    done: "Academy suspended.",
  },
  reactivate: {
    label: "Reactivate",
    hint: "Restores sign-in. Reason optional.",
    title: "Reactivate this academy?",
    description: "Restores access for a suspended academy. A lapsed subscription is renewed on the Subscriptions page instead.",
    danger: false,
    rules: [],
    done: "Academy reactivated.",
  },
  cancel: {
    label: "Cancel",
    hint: "Ends the subscription. Reason required.",
    title: "Cancel this subscription?",
    description: "The subscription ends and the academy loses access.",
    danger: true,
    rules: REQUIRED_REASON,
    done: "Subscription cancelled.",
  },
  close: {
    label: "Close",
    hint: "Permanent. Reason and confirmation required.",
    title: "Close this academy permanently?",
    description: "Closing cannot be undone. The academy's history is kept and stays verifiable.",
    danger: true,
    rules: CLOSE_RULES,
    done: "Academy closed.",
  },
};

/**
 * Lifecycle actions (design P02 detail): a short list of the actions the
 * subscription's current state allows, each a button with its rule written
 * beside it. Suspend, Cancel and Close ask for a reason in a dialog (Close
 * also needs a confirmation tick); Reactivate takes an optional reason;
 * Activate needs every onboarding item done and shows why when it is not.
 * Renew lives on the Subscriptions page. The server re-checks every rule.
 */
export function LifecycleActions({
  academyId,
  academyName,
  subscriptionStatus,
  checklistSatisfied,
  checklistUnmetReasons,
  academyClosed,
}: LifecycleActionsProps) {
  const router = useRouter();
  const [acting, setActing] = useState<Kind | null>(null);

  if (academyClosed) {
    return <p className="text-sm text-[#374151]">This academy is permanently closed. No lifecycle actions are available.</p>;
  }

  if (subscriptionStatus === null) {
    return <p className="text-sm text-[#374151]">This academy has no subscription yet. Lifecycle actions become available once one is created.</p>;
  }

  const canActivate = ACTIVATE_SOURCES.has(subscriptionStatus);
  const kinds: Kind[] = [
    ...(SUSPEND_SOURCES.has(subscriptionStatus) ? (["suspend"] as const) : []),
    ...(REACTIVATE_SOURCES.has(subscriptionStatus) ? (["reactivate"] as const) : []),
    ...(CANCEL_SOURCES.has(subscriptionStatus) ? (["cancel"] as const) : []),
    "close",
  ];

  const run = async (kind: Kind, data: FormData): Promise<string | null> => {
    const reason = String(data.get("reason") ?? "").trim();
    let result: LifecycleActionResult;
    if (kind === "suspend") result = await suspendAcademyAction(academyId, reason);
    else if (kind === "reactivate") result = await reactivateAcademyAction(academyId, reason || undefined);
    else if (kind === "cancel") result = await cancelAcademyAction(academyId, reason);
    else result = await closeAcademyAction(academyId, reason);
    return result.ok ? null : result.error.message;
  };

  const copy = acting ? COPY[acting] : null;

  return (
    <>
      <ul role="list" className="flex flex-col gap-3">
        {canActivate && (
          <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <ConfirmButton
              label="Activate"
              variant="primary"
              disabled={!checklistSatisfied}
              title={`Activate ${academyName}?`}
              description="Starts the subscription so the academy can be used."
              successMessage="Academy activated."
              onConfirm={() => activateAcademyAction(academyId)}
              onSuccess={() => router.refresh()}
            />
            {checklistSatisfied ? (
              <span className="text-xs text-[#374151]">Every onboarding item is done.</span>
            ) : (
              <span className="text-xs text-[#374151]">Not yet: {checklistUnmetReasons.join(" ")}</span>
            )}
          </li>
        )}
        {kinds.map((kind) => (
          <li key={kind} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <button type="button" className={COPY[kind].danger && kind !== "cancel" ? ROW_BTN_DANGER : ROW_BTN} onClick={() => setActing(kind)}>
              {COPY[kind].label}
            </button>
            <span className="text-xs text-[#374151]">{COPY[kind].hint}</span>
          </li>
        ))}
      </ul>

      <ActionDialog
        open={acting !== null}
        onOpenChange={(open) => !open && setActing(null)}
        title={copy?.title ?? ""}
        description={copy?.description}
        summary={[{ label: "Academy", value: academyName }]}
        submitLabel={copy?.label ?? ""}
        pendingLabel="Working…"
        danger={copy?.danger}
        rules={copy?.rules ?? []}
        run={(data) => (acting ? run(acting, data) : Promise.resolve(null))}
        onDone={() => {
          if (copy) showSuccessToast(copy.done);
          setActing(null);
          router.refresh();
        }}
      >
        {({ errors, blur }) => (
          <>
            {acting === "reactivate" ? (
              <DField label="Reason (optional)" name="reason" full>
                <textarea name="reason" rows={3} maxLength={500} className={controlClass(false, true)} />
              </DField>
            ) : (
              <ReasonField errors={errors} blur={blur} />
            )}
            {acting === "close" && (
              <DField label="Confirmation" name="confirm" error={errors.confirm} full>
                <span className="flex items-start gap-2.5 font-normal">
                  <input
                    type="checkbox"
                    name="confirm"
                    value="yes"
                    className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-brand"
                    {...invalidProps("confirm", errors.confirm)}
                  />
                  I understand closing is permanent and cannot be undone.
                </span>
              </DField>
            )}
          </>
        )}
      </ActionDialog>
    </>
  );
}
