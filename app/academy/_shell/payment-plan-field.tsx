"use client";

import { useId, useState } from "react";
import { MONTHLY_INSTALLMENT_COUNTS } from "@/lib/ui/payment-plan";
import { controlClass } from "./design-form";

const CHIP =
  "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border-strong bg-surface px-3.5 text-sm font-semibold text-ink transition-colors duration-150 hover:bg-app has-[:checked]:border-brand has-[:checked]:bg-brand-tint has-[:checked]:text-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/30";

/**
 * The payment-plan choice used wherever a fee plan is set: Full payment, or
 * Monthly installments plus how many. Both map onto the one stored value,
 * the number of equal monthly installments (1 = full payment; see
 * lib/ui/payment-plan.ts), submitted under `name` exactly as the plain
 * select it replaces. Controlled with `value`/`onChange`, or uncontrolled
 * with `defaultValue`. Plan types the data model can't store (every two
 * months, quarterly, custom, deposit) are deliberately not offered.
 */
export function PaymentPlanField({
  name,
  value,
  defaultValue = 1,
  onChange,
  label = "Payment plan",
}: {
  name: string;
  value?: number;
  defaultValue?: number;
  onChange?: (installments: number) => void;
  label?: string;
}) {
  const id = useId();
  const [own, setOwn] = useState(defaultValue);
  const installments = value ?? own;
  // The count to come back to when switching Full -> Monthly again.
  const [lastMonthly, setLastMonthly] = useState(installments > 1 ? installments : MONTHLY_INSTALLMENT_COUNTS[0]);
  const monthly = installments > 1;

  function choose(next: number) {
    if (next > 1) setLastMonthly(next);
    if (value === undefined) setOwn(next);
    onChange?.(next);
  }

  return (
    <div className="col-span-full flex min-w-0 flex-col gap-3">
      <input type="hidden" name={name} value={installments} />
      <div role="radiogroup" aria-labelledby={`${id}-label`} className="flex min-w-0 flex-col gap-1.5">
        <span id={`${id}-label`} className="text-[13px] font-semibold text-ink">
          {label}
        </span>
        <span className="flex flex-wrap gap-2">
          <label className={CHIP}>
            <input type="radio" name={`${id}-kind`} checked={!monthly} onChange={() => choose(1)} className="sr-only" />
            Full payment
          </label>
          <label className={CHIP}>
            <input type="radio" name={`${id}-kind`} checked={monthly} onChange={() => choose(lastMonthly)} className="sr-only" />
            Monthly installments
          </label>
        </span>
        <span className="text-xs font-normal text-muted">
          {monthly
            ? `The fee is split into ${installments} equal monthly installments, one due each month.`
            : "The whole fee is due as one payment."}
        </span>
      </div>
      {monthly && (
        <label className="flex min-w-0 flex-col gap-1.5 text-[13px] font-semibold text-ink sm:max-w-xs">
          Number of monthly installments
          <select value={installments} onChange={(event) => choose(Number(event.target.value))} className={controlClass(false)}>
            {MONTHLY_INSTALLMENT_COUNTS.map((count) => (
              <option key={count} value={count}>
                {count} months
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
