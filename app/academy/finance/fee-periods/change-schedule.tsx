"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { FeePeriodRecord } from "@/lib/academies/fee-periods";
import { listFeePeriodsForEnrollmentAction, setEnrollmentFeeScheduleAction } from "@/lib/academies/fee-periods-actions";
import { previewScheduleChange } from "@/lib/ui/fee-allocation";
import { formatDate } from "@/lib/ui/date";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { centsToDollars, dollarsToCents, formatMoney } from "@/lib/ui/money";
import { describePaymentPlan } from "@/lib/ui/payment-plan";
import { PaymentPlanField } from "@/app/academy/_shell/payment-plan-field";
import { showSuccessToast } from "@/lib/ui/toast";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";
import { ActionDialog, DField, controlClass, invalidProps, type DesignFormRule } from "@/app/academy/_shell/design-form";

/**
 * Change schedule (design `schedule` form): payment plan and total fee for
 * one enrollment, through the existing audited `setEnrollmentFeeSchedule`.
 * Once an installment has started (or been paid) the server keeps it with
 * its own amount, carries the part of the plan no kept installment already
 * charges, and picks the next start date itself, so the amount is shown
 * locked to that figure (lib/ui/fee-allocation.ts mirrors the rule, from
 * the enrollment's periods, loaded when the dialog opens) and the start
 * date field is not offered. When every installment is kept the change is
 * refused rather than charging beyond the course fee.
 */
export function ChangeScheduleButton({
  enrollmentId,
  studentName,
  batchLabel,
  schedule,
  paidCents,
  hasStarted,
  today,
}: {
  enrollmentId: string;
  studentName: string;
  batchLabel: string;
  schedule: { intervalMonths: number; amountCents: number; currency: string; anchorDate: string };
  paidCents: number;
  hasStarted: boolean;
  /** The academy's today (YYYY-MM-DD), as the server judges "started". */
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [intervalMonths, setIntervalMonths] = useState(schedule.intervalMonths);
  const [periods, setPeriods] = useState<FeePeriodRecord[] | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listFeePeriodsForEnrollmentAction(enrollmentId).then((result) => {
      if (!cancelled) setPeriods(result.ok ? result.periods : []);
    });
    return () => {
      cancelled = true;
    };
  }, [open, enrollmentId]);

  const preview = periods
    ? previewScheduleChange({
        current: { amountCents: schedule.amountCents, anchorDate: schedule.anchorDate },
        periods,
        today,
        amountCents: schedule.amountCents,
        anchorDate: schedule.anchorDate,
        count: intervalMonths,
      })
    : null;
  const locked = preview ? preview.dateMoved : hasStarted;
  const NOTHING_LEFT =
    "Every installment of this plan has started or been paid, so there is nothing left to reschedule. Changing it would charge more than the course fee.";

  const rules: DesignFormRule[] = [
    ...(locked
      ? []
      : [
          {
            name: "amountDollars",
            label: "Total fee (USD)",
            required: true,
            check: (value: string) => {
              const cents = dollarsToCents(value);
              return cents === null || cents <= 0 ? "Enter the full fee, for example 180.00." : null;
            },
          },
          { name: "anchorDate", label: "First payment starts", required: true },
        ]),
  ];

  return (
    <>
      <button type="button" className={ROW_BTN} onClick={() => setOpen(true)}>
        Change schedule
      </button>
      <ActionDialog
        open={open}
        onOpenChange={setOpen}
        title="Change fee schedule"
        description="Started or paid installments stay as they are. The rest of the plan is spread over the new installments."
        summary={[
          { label: "Student", value: studentName },
          { label: "Batch", value: batchLabel },
          { label: "Current plan", value: describePaymentPlan(schedule.amountCents, schedule.intervalMonths, schedule.currency) },
          { label: "Paid toward it", value: formatMoney(paidCents, schedule.currency) },
        ]}
        submitLabel="Save schedule"
        pendingLabel="Saving…"
        rules={rules}
        run={async (data) => {
          if (preview?.nothingToReschedule) return NOTHING_LEFT;
          try {
            const result = await setEnrollmentFeeScheduleAction({
              enrollmentId,
              intervalMonths: Number(data.get("intervalMonths")),
              // When locked the server overrides both with the carried amount
              // and the next unstarted period; these are only placeholders.
              amountCents: locked ? Math.max(1, preview?.totalCents ?? 1) : dollarsToCents(String(data.get("amountDollars") ?? ""))!,
              anchorDate: locked ? schedule.anchorDate : String(data.get("anchorDate") ?? ""),
            });
            return result.ok ? null : (result.error?.message ?? "The schedule couldn't be saved.");
          } catch {
            return NETWORK_ERROR_MESSAGE;
          }
        }}
        onDone={() => {
          showSuccessToast("Fee schedule saved.");
          setOpen(false);
          router.refresh();
        }}
      >
        {({ errors, blur }) => (
          <>
            <PaymentPlanField name="intervalMonths" value={intervalMonths} onChange={setIntervalMonths} />
            {locked ? (
              <>
                <DField
                  label="Amount still to schedule"
                  name="carried"
                  full
                  hint="Started or paid installments stay as they are, with their own amounts and balances. The rest of the plan carries into the new installments, so the total owed doesn't change."
                >
                  <input
                    type="text"
                    value={preview ? formatMoney(preview.totalCents, schedule.currency) : "Loading…"}
                    readOnly
                    disabled
                    className={controlClass(false)}
                  />
                </DField>
                {preview && (
                  <div className="col-span-full rounded-lg border border-border bg-[#FAFBFC] p-3 text-[13px]" aria-live="polite">
                    {preview.nothingToReschedule ? (
                      <p role="alert" className="text-[#7A4B00]">
                        {NOTHING_LEFT}
                      </p>
                    ) : (
                      <>
                        <div className="mb-1.5 font-semibold text-ink">New installments (preview, not saved)</div>
                        <ul className="divide-y divide-border">
                          {preview.installments.map((installment, index) => (
                            <li key={installment.date} className="flex justify-between gap-3 py-1.5">
                              <span className="text-[#374151]">
                                {index + 1}. due {formatDate(installment.date)}
                              </span>
                              <span className="font-semibold tabular-nums text-ink">
                                {formatMoney(installment.amountCents, schedule.currency)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <DField label="Total fee (USD)" name="amountDollars" required error={errors.amountDollars}>
                  <input
                    type="text"
                    inputMode="decimal"
                    name="amountDollars"
                    defaultValue={centsToDollars(schedule.amountCents)}
                    onBlur={blur("amountDollars")}
                    className={controlClass(Boolean(errors.amountDollars))}
                    {...invalidProps("amountDollars", errors.amountDollars)}
                  />
                </DField>
                <DField label="First payment starts" name="anchorDate" required error={errors.anchorDate}>
                  <input
                    type="date"
                    name="anchorDate"
                    defaultValue={schedule.anchorDate}
                    onBlur={blur("anchorDate")}
                    className={controlClass(Boolean(errors.anchorDate))}
                    {...invalidProps("anchorDate", errors.anchorDate)}
                  />
                </DField>
              </>
            )}
          </>
        )}
      </ActionDialog>
    </>
  );
}
