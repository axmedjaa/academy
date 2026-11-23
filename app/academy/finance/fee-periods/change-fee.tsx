"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { FeePlanPosition, FeePlanTarget } from "@/lib/academies/fee-plan-change";
import { changeFeePlanAction, getFeePlanPositionAction } from "@/lib/academies/fee-plan-change-actions";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { centsToDollars, dollarsToCents, formatMoney } from "@/lib/ui/money";
import { describePaymentPlan } from "@/lib/ui/payment-plan";
import { showSuccessToast } from "@/lib/ui/toast";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";
import { PaymentPlanField } from "@/app/academy/_shell/payment-plan-field";
import { ActionDialog, ChoiceChips, DField, controlClass } from "@/app/academy/_shell/design-form";

type Scholarship = "none" | "partial" | "full";

const SCHOLARSHIP_OPTIONS: { value: Scholarship; label: string }[] = [
  { value: "none", label: "No scholarship" },
  { value: "partial", label: "Partial scholarship" },
  { value: "full", label: "Full scholarship (free)" },
];

/**
 * Change fee: a course or program enrollment's fee, discount or scholarship
 * and its number of monthly payments, after enrollment
 * (lib/academies/fee-plan-change.ts). What was already paid stays; the rest
 * of the new fee is spread over the new monthly payments. The figures are
 * loaded when the dialog opens.
 */
export function ChangeFeeButton({
  target,
  studentName,
  label,
  className = ROW_BTN,
  onSaved,
}: {
  target: FeePlanTarget;
  studentName: string;
  /** "BATCH · Course" or "Program · name". */
  label: string;
  className?: string;
  /** After a save (e.g. reload periods fetched on the client). */
  onSaved?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<FeePlanPosition | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scholarship, setScholarship] = useState<Scholarship>("none");
  const [fee, setFee] = useState("");
  const [discount, setDiscount] = useState("");
  const [installments, setInstallments] = useState(1);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getFeePlanPositionAction(target)
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) return setLoadError(result.error.message);
        const current = result.position;
        setPosition(current);
        setScholarship(current.scholarship ?? "none");
        setFee(current.feeCents > 0 ? centsToDollars(current.feeCents) : "");
        setDiscount(current.discountCents > 0 ? centsToDollars(current.discountCents) : "");
        setInstallments(current.installments ?? 1);
      })
      .catch(() => !cancelled && setLoadError(NETWORK_ERROR_MESSAGE));
    return () => {
      cancelled = true;
    };
    // The target is identified by its id; a new object each render must not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target.kind === "course" ? target.enrollmentId : target.programEnrollmentId]);

  const currency = position?.currency ?? "USD";
  const free = scholarship === "full";
  const feeCents = fee.trim() ? dollarsToCents(fee) : null;
  const discountCents = discount.trim() ? dollarsToCents(discount) : 0;
  let problem: string | null = null;
  if (!free) {
    if (feeCents === null || feeCents <= 0) problem = "Enter the fee, for example 120 or 120.50.";
    else if (discountCents === null) problem = "Enter the amount taken off, for example 20.";
    else if (discountCents >= feeCents) problem = scholarship === "partial" ? "The scholarship must be less than the fee. Choose Full scholarship for free." : "The discount must be less than the fee.";
    else if (scholarship === "partial" && discountCents <= 0) problem = "Enter the scholarship amount taken off the fee.";
  }
  const finalCents = free ? 0 : feeCents !== null && discountCents !== null ? Math.max(0, feeCents - discountCents) : null;
  const paidCents = position?.paidCents ?? 0;
  const leftCents = finalCents === null ? null : finalCents - paidCents;
  if (!problem && leftCents !== null && leftCents < 0) {
    problem = `${formatMoney(paidCents, currency)} is already paid, more than the new fee. Record a refund instead, or enter a higher fee.`;
  }

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => {
          setPosition(null);
          setLoadError(null);
          setOpen(true);
        }}
      >
        Change fee
      </button>
      <ActionDialog
        open={open}
        onOpenChange={setOpen}
        title="Change fee"
        description="What was already paid stays as it is. The rest of the new fee is spread over the new monthly payments."
        summary={[
          { label: "Student", value: studentName },
          { label: "Enrollment", value: label },
          { label: "Paid so far", value: position ? formatMoney(paidCents, currency) : "Loading…" },
        ]}
        submitLabel="Save fee"
        pendingLabel="Saving…"
        rules={[]}
        run={async () => {
          if (!position) return loadError ?? "Still loading the current fee. Try again in a moment.";
          if (problem) return problem;
          try {
            const result = await changeFeePlanAction({
              target,
              scholarship,
              feeCents: free ? 0 : (feeCents ?? 0),
              discountCents: free ? 0 : (discountCents ?? 0),
              installments,
            });
            return result.ok ? null : (result.error?.message ?? "The fee couldn't be saved.");
          } catch {
            return NETWORK_ERROR_MESSAGE;
          }
        }}
        onDone={() => {
          showSuccessToast("Fee saved.");
          setOpen(false);
          onSaved?.();
          router.refresh();
        }}
      >
        {() =>
          loadError ? (
            <p role="alert" className="col-span-full text-[13px] font-medium text-[#B91C1C]">
              {loadError}
            </p>
          ) : !position ? (
            <p className="col-span-full text-[13px] text-muted">Loading the current fee…</p>
          ) : (
            <>
              <DField label="Scholarship" name="cf-scholarship" group full>
                <ChoiceChips
                  name="scholarship"
                  options={SCHOLARSHIP_OPTIONS}
                  defaultValue={scholarship}
                  onChange={(value) => setScholarship(value as Scholarship)}
                />
              </DField>
              {!free && (
                <>
                  <DField label={`Fee (${currency})`} name="cf-fee" required hint="The full fee before any discount or scholarship.">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={fee}
                      onChange={(event) => setFee(event.target.value)}
                      placeholder="0.00"
                      className={controlClass(false)}
                    />
                  </DField>
                  <DField
                    label={scholarship === "partial" ? `Scholarship amount (${currency})` : `Discount (${currency}, optional)`}
                    name="cf-discount"
                    required={scholarship === "partial"}
                  >
                    <input
                      type="text"
                      inputMode="decimal"
                      value={discount}
                      onChange={(event) => setDiscount(event.target.value)}
                      placeholder="0.00"
                      className={controlClass(false)}
                    />
                  </DField>
                  <div className="col-span-full">
                    <PaymentPlanField
                      name="installments"
                      label="Monthly payments for the rest"
                      value={installments}
                      onChange={setInstallments}
                    />
                  </div>
                </>
              )}
              <div className="col-span-full rounded-lg border border-border bg-[#FAFBFC] p-3 text-[13px]" aria-live="polite">
                <dl className="grid grid-cols-1 gap-1 tabular-nums">
                  <div className="flex justify-between gap-3">
                    <dt className="text-[#374151]">New fee after {scholarship === "none" ? "discount" : "scholarship"}</dt>
                    <dd className="font-semibold text-ink">{finalCents === null ? "—" : formatMoney(finalCents, currency)}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-[#374151]">Already paid (kept)</dt>
                    <dd className="font-semibold text-ink">{formatMoney(paidCents, currency)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 border-t border-border pt-1">
                    <dt className="font-semibold text-ink">Still to pay</dt>
                    <dd className="font-semibold text-ink">{leftCents === null || leftCents < 0 ? "—" : formatMoney(leftCents, currency)}</dd>
                  </div>
                </dl>
                <p className="mt-1.5 text-muted">
                  {problem
                    ? null
                    : leftCents === null
                      ? null
                      : leftCents === 0
                        ? free
                          ? "Free: nothing more is ever due."
                          : "Nothing more is due."
                        : describePaymentPlan(leftCents, installments, currency)}
                </p>
                {problem && (fee || discount || free) && (
                  <p role="alert" className="mt-1.5 font-medium text-[#B91C1C]">
                    {problem}
                  </p>
                )}
              </div>
            </>
          )
        }
      </ActionDialog>
    </>
  );
}
