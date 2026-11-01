"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { changeAcademyPlan } from "@/lib/subscriptions/change-plan-actions";
import type { LimitStatusRow } from "@/lib/subscriptions/usage";
import { PLAN_FEATURES, PLAN_LIMITS, formatLimit } from "@/lib/subscriptions/plan-catalog";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { formatMoney } from "@/lib/ui/money";
import { DField, DesignDialog, DialogBody, DialogFooter, FormErrorBanner, controlClass } from "@/app/academy/_shell/design-form";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";

export interface ChangePlanOption {
  id: string;
  name: string;
  priceAmountCents: number;
  currency: string;
  billingPeriod: string;
  limits: Record<(typeof PLAN_LIMITS)[number]["key"], number | null>;
  features: Record<(typeof PLAN_FEATURES)[number]["column"], boolean>;
}

const RESOURCE_LABEL = Object.fromEntries(PLAN_LIMITS.map((limit) => [limit.resource, limit])) as Record<
  string,
  (typeof PLAN_LIMITS)[number]
>;

/**
 * Platform owner: move this academy to another active, priced plan. The
 * server applies the same rules (lib/subscriptions/change-plan.ts); this
 * only shows the choices and the result.
 */
export function ChangePlanButton({
  academyId,
  currentPlanId,
  options,
}: {
  academyId: string;
  currentPlanId: string;
  options: ChangePlanOption[];
}) {
  const router = useRouter();
  const choices = options.filter((option) => option.id !== currentPlanId);
  const [open, setOpen] = useState(false);
  const [planId, setPlanId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [overLimit, setOverLimit] = useState<LimitStatusRow[] | null>(null);
  const [pending, startTransition] = useTransition();
  const selected = choices.find((option) => option.id === planId) ?? null;

  function close(next: boolean) {
    setOpen(next);
    if (!next) {
      setPlanId("");
      setError(null);
      setOverLimit(null);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) {
      setError("Choose a plan.");
      return;
    }
    startTransition(async () => {
      try {
        const result = await changeAcademyPlan(academyId, selected.id);
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        showSuccessToast(`Plan changed to ${result.planName}.`);
        router.refresh();
        if (result.overLimit.length > 0) setOverLimit(result.overLimit);
        else close(false);
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  if (choices.length === 0) {
    return <p className="mt-3 text-xs text-[#4B5563]">No other active, priced plan to move to.</p>;
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`${ROW_BTN} mt-3`}>
        Change plan
      </button>
      <DesignDialog
        open={open}
        onOpenChange={close}
        title="Change plan"
        description="The new limits and features apply now. The new price applies from the next renewal; nothing is charged."
      >
        {overLimit ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <DialogBody>
              <div role="status" className="rounded-lg border border-[#FDE68A] bg-warning-bg p-4 text-sm text-ink">
                <p className="font-semibold text-warning">The plan was changed. The academy is above these limits:</p>
                <ul className="mt-2 grid gap-1">
                  {overLimit.map((row) => {
                    const limit = RESOURCE_LABEL[row.resource];
                    return (
                      <li key={row.resource}>
                        {limit.label}: {formatLimit(limit.unit, row.current)} used of {formatLimit(limit.unit, row.limit)}
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-2 text-[#374151]">
                  Nothing was deleted and the academy stays active. It can&apos;t add more of these until it&apos;s under the limit.
                </p>
              </div>
            </DialogBody>
            <div className="flex justify-end border-t border-border bg-app px-6 py-4">
              <button
                type="button"
                onClick={() => close(false)}
                className="h-11 rounded-lg bg-brand px-5 text-sm font-semibold text-white hover:bg-brand-hover"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
            <DialogBody>
              <DField label="New plan" name="cp-plan" required error={error ?? undefined} full>
                <select
                  value={planId}
                  onChange={(event) => {
                    setPlanId(event.target.value);
                    setError(null);
                  }}
                  className={controlClass(Boolean(error))}
                >
                  <option value="">Choose a plan</option>
                  {choices.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name} · {formatMoney(option.priceAmountCents, option.currency)} / {option.billingPeriod}
                    </option>
                  ))}
                </select>
              </DField>
              {selected && (
                <dl className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-6 gap-y-2 rounded-lg border border-border bg-app p-4 text-sm">
                  {PLAN_LIMITS.map((limit) => (
                    <div key={limit.key} className="flex justify-between gap-3">
                      <dt className="text-[#374151]">{limit.label}</dt>
                      <dd className="font-semibold tabular-nums text-ink">{formatLimit(limit.unit, selected.limits[limit.key])}</dd>
                    </div>
                  ))}
                  {PLAN_FEATURES.map((feature) => (
                    <div key={feature.key} className="flex justify-between gap-3">
                      <dt className="text-[#374151]">{feature.label}</dt>
                      <dd className="font-semibold text-ink">{selected.features[feature.column] ? "Included" : "Not included"}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <FormErrorBanner message={null} />
            </DialogBody>
            <DialogFooter onCancel={() => close(false)} submitLabel="Change plan" pendingLabel="Changing…" pending={pending} />
          </form>
        )}
      </DesignDialog>
    </>
  );
}
