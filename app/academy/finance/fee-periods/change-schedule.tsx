"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { setEnrollmentFeeScheduleAction } from "@/lib/academies/fee-periods-actions";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { centsToDollars, dollarsToCents, formatMoney } from "@/lib/ui/money";
import { PAYMENT_PLAN_OPTIONS, describePaymentPlan } from "@/lib/ui/payment-plan";
import { showSuccessToast } from "@/lib/ui/toast";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";
import { ActionDialog, DField, controlClass, invalidProps, type DesignFormRule } from "@/app/academy/_shell/design-form";

/**
 * Change schedule (design `schedule` form): payment plan and total fee for
 * one enrollment, through the existing audited `setEnrollmentFeeSchedule`.
 * Once an installment has started the server keeps it, carries the unpaid
 * balance and picks the next start date itself, so the total is shown
 * locked to that balance and the start date field is not offered.
 */
export function ChangeScheduleButton({
  enrollmentId,
  studentName,
  batchLabel,
  schedule,
  paidCents,
  hasStarted,
}: {
  enrollmentId: string;
  studentName: string;
  batchLabel: string;
  schedule: { intervalMonths: number; amountCents: number; currency: string; anchorDate: string };
  paidCents: number;
  hasStarted: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const locked = hasStarted;
  const carried = Math.max(0, schedule.amountCents - paidCents);

  const rules: DesignFormRule[] = [
    { name: "intervalMonths", label: "Payment plan", required: true, kind: "select" },
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
        description="Total is the full fee. Remaining balance carries over."
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
          try {
            const result = await setEnrollmentFeeScheduleAction({
              enrollmentId,
              intervalMonths: Number(data.get("intervalMonths")),
              // When locked the server overrides both with the carried balance
              // and the next unstarted period; these are only placeholders.
              amountCents: locked ? Math.max(1, carried) : dollarsToCents(String(data.get("amountDollars") ?? ""))!,
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
            <DField label="Payment plan" name="intervalMonths" required error={errors.intervalMonths}>
              <select
                name="intervalMonths"
                defaultValue={String(schedule.intervalMonths)}
                onBlur={blur("intervalMonths")}
                className={controlClass(Boolean(errors.intervalMonths))}
                {...invalidProps("intervalMonths", errors.intervalMonths)}
              >
                {PAYMENT_PLAN_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </DField>
            {locked ? (
              <DField
                label="Remaining balance"
                name="carried"
                hint="Installments have already started, so the unpaid balance carries into the new plan from the next installment."
              >
                <input type="text" value={formatMoney(carried, schedule.currency)} readOnly disabled className={controlClass(false)} />
              </DField>
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
