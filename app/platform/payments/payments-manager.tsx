"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useState } from "react";
import {
  recordSubscriptionPayment,
  verifySubscriptionPayment,
  rejectSubscriptionPayment,
  reverseSubscriptionPayment,
  type PaymentFormState,
} from "@/lib/subscriptions/payments-actions";
import type {
  AcademySubscriptionOption,
  SubscriptionPaymentFilterOptions,
  SubscriptionPaymentRecord,
} from "@/lib/subscriptions/payments";
import { guardAction } from "@/lib/ui/guard-action";
import { formatCalendarDate } from "@/lib/ui/date";
import { showSuccessToast } from "@/lib/ui/toast";
import { Badge, Button, EmptyState, Section } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { DataTable, ROW_BTN, ROW_BTN_DANGER, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ClearFilters, FilterSelect, SearchField } from "@/app/academy/_shell/filter-controls";
import {
  ActionDialog,
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  ReasonField,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";

const guardedRecord = guardAction(recordSubscriptionPayment);
const initialState: PaymentFormState = { ok: false };

const STATUS_TONE: Record<SubscriptionPaymentRecord["status"], "amber" | "green" | "red" | "slate"> = {
  pending: "amber",
  verified: "green",
  rejected: "red",
  reversed: "slate",
};

type ReasonKind = "verify" | "reject" | "reverse";

const REASON_ACTION: Record<
  ReasonKind,
  (id: string, reason: string) => Promise<{ ok: true } | { ok: false; error: { message: string } }>
> = {
  verify: verifySubscriptionPayment,
  reject: rejectSubscriptionPayment,
  reverse: reverseSubscriptionPayment,
};

const REASON_COPY: Record<ReasonKind, { label: string; past: string; description: string }> = {
  verify: {
    label: "Verify",
    past: "verified",
    description: "Confirms the money was received. A verified payment can be used to renew the subscription.",
  },
  reject: {
    label: "Reject",
    past: "rejected",
    description: "Marks this payment as not received. It cannot be used for a renewal.",
  },
  reverse: {
    label: "Reverse",
    past: "reversed",
    description: "Marks this same payment Reversed. No new linked record is created.",
  },
};

const REASON_RULES: DesignFormRule[] = [{ name: "reason", label: "Reason", required: true }];

const amountLabel = (payment: SubscriptionPaymentRecord) => `${(payment.amountCents / 100).toFixed(2)} ${payment.currency}`;

interface Props {
  payments: SubscriptionPaymentRecord[];
  academyNames: Record<string, string>;
  subscriptionOptions: AcademySubscriptionOption[];
  canVerify: boolean;
  filterOptions: SubscriptionPaymentFilterOptions;
  /** Whether any filter is applied (drives the empty-state wording). */
  filtersActive: boolean;
  /** Payments matching the filters, across all pages. */
  matchingCount: number;
  /** Every payment, unfiltered. */
  overallCount: number;
  /** Verified amounts among the matching payments, per currency. */
  verifiedTotals: { currency: string; amountCents: number }[];
}

const FILTER_PARAMS = ["q", "status", "method", "academy", "plan", "month"];
const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function monthLabel(key: string): string {
  const [year, month] = key.split("-").map(Number);
  return MONTH_LABEL.format(new Date(Date.UTC(year, month - 1, 1)));
}

/** "1,250.00 USD + 300.00 SOS"; amounts in different currencies are never summed together. */
function verifiedLabel(totals: { currency: string; amountCents: number }[]): string {
  if (totals.length === 0) return "Nothing verified in this view";
  const parts = totals.map(
    (total) => `${(total.amountCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${total.currency}`,
  );
  return `${parts.join(" + ")} verified in this view`;
}

/** Design P07 filter bar: search, then Status, Method, Academy, Plan and
 * Date selects, Clear filters while any is set, and Record payment on the right. */
function PaymentFilters({
  options,
  subscriptionOptions,
}: {
  options: SubscriptionPaymentFilterOptions;
  subscriptionOptions: AcademySubscriptionOption[];
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <SearchField placeholder="Search payment ID or academy" />
      <FilterSelect
        param="status"
        label="Filter by status"
        options={[
          { value: "", label: "All statuses" },
          { value: "pending", label: "Pending" },
          { value: "verified", label: "Verified" },
          { value: "rejected", label: "Rejected" },
          { value: "reversed", label: "Reversed" },
        ]}
      />
      <FilterSelect
        param="method"
        label="Filter by method"
        options={[{ value: "", label: "All methods" }, ...options.methods.map((method) => ({ value: method, label: method }))]}
      />
      <FilterSelect
        param="academy"
        label="Filter by academy"
        options={[{ value: "", label: "All academies" }, ...options.academies.map((academy) => ({ value: academy.id, label: academy.name }))]}
      />
      <FilterSelect
        param="plan"
        label="Filter by plan"
        options={[{ value: "", label: "All plans" }, ...options.plans.map((plan) => ({ value: plan.id, label: plan.name }))]}
      />
      <FilterSelect
        param="month"
        label="Filter by date"
        options={[{ value: "", label: "Any date" }, ...options.months.map((month) => ({ value: month, label: monthLabel(month) }))]}
      />
      <ClearFilters params={FILTER_PARAMS} compact />
      <div className="hidden flex-1 sm:block" />
      <RecordPaymentButton subscriptionOptions={subscriptionOptions} />
    </div>
  );
}

/**
 * Payments (design P07): the payment history table with Record payment in
 * a dialog. Recording is the grantable capability and always creates a
 * pending row; Verify / Reject (pending rows) and Reverse (verified rows)
 * are owner-only, each asks for a reason, and the Actions column is left
 * out of the DOM entirely for anyone who cannot verify.
 */
export function PaymentsManager({
  payments,
  academyNames,
  subscriptionOptions,
  canVerify,
  filterOptions,
  filtersActive,
  matchingCount,
  overallCount,
  verifiedTotals,
}: Props) {
  const [acting, setActing] = useState<{ payment: SubscriptionPaymentRecord; kind: ReasonKind } | null>(null);
  const copy = acting ? REASON_COPY[acting.kind] : null;

  return (
    <>
      <PaymentFilters options={filterOptions} subscriptionOptions={subscriptionOptions} />
      <p className="mb-3 flex flex-wrap items-baseline gap-x-5 gap-y-2 text-[13px] text-muted" aria-live="polite">
        <span>
          Showing {matchingCount.toLocaleString("en-US")} of {overallCount.toLocaleString("en-US")} payment{overallCount === 1 ? "" : "s"}
        </span>
        <span className="font-semibold tabular-nums text-ink">{verifiedLabel(verifiedTotals)}</span>
      </p>

      {payments.length === 0 && filtersActive ? (
        <div className="mb-8 rounded-card border border-border bg-surface px-4 py-10 text-center text-[#374151]">
          No payments match these filters. <ClearFilters params={FILTER_PARAMS} compact />
        </div>
      ) : payments.length === 0 ? (
        <Section className="mb-8">
          <EmptyState message="No payments recorded yet." icon={<Icon name="payments" />} />
        </Section>
      ) : (
        <DataTable stackBelow={900}>
          <thead>
            <tr>
              <th className={rtTh}>Payment</th>
              <th className={rtTh}>Academy</th>
              <th className={`${rtTh} text-right`}>Amount</th>
              <th className={rtTh}>Method</th>
              <th className={rtTh}>Date</th>
              <th className={rtTh}>Status</th>
              {canVerify && <th className={rtTh}>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {payments.map((payment) => (
              <tr key={payment.id}>
                <td className={rtTd} data-label="Payment">
                  <span className="font-mono text-xs uppercase text-[#374151]" title={payment.id}>
                    {payment.id.slice(0, 8)}
                  </span>
                  {payment.paymentReference && (
                    <span className="block text-xs text-muted [overflow-wrap:anywhere]">Ref {payment.paymentReference}</span>
                  )}
                </td>
                <td className={rtTd} data-label="Academy">
                  <Link
                    href={`/platform/academies/${payment.academyId}`}
                    className="font-semibold !text-ink no-underline [overflow-wrap:anywhere] hover:!text-brand hover:underline"
                  >
                    {academyNames[payment.academyId] ?? "Unknown academy"}
                  </Link>
                </td>
                <td className={`${rtTd} whitespace-nowrap text-right tabular-nums`} data-label="Amount">
                  {amountLabel(payment)}
                </td>
                <td className={`${rtTd} break-words`} data-label="Method">
                  {payment.paymentMethod}
                </td>
                <td className={`${rtTd} whitespace-nowrap text-muted`} data-label="Date">
                  {formatCalendarDate(payment.receivedAt)}
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge label={payment.status} tone={STATUS_TONE[payment.status]} />
                </td>
                {canVerify && (
                  <td className={rtTd} data-label="Actions" data-actions>
                    <div className="flex items-center gap-2">
                      {payment.status === "pending" && (
                        <>
                          <button type="button" className={ROW_BTN} onClick={() => setActing({ payment, kind: "verify" })}>
                            Verify
                          </button>
                          <button type="button" className={ROW_BTN_DANGER} onClick={() => setActing({ payment, kind: "reject" })}>
                            Reject
                          </button>
                        </>
                      )}
                      {payment.status === "verified" && (
                        <button type="button" className={ROW_BTN_DANGER} onClick={() => setActing({ payment, kind: "reverse" })}>
                          Reverse
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {canVerify && (
        <ActionDialog
          open={acting !== null}
          onOpenChange={(open) => !open && setActing(null)}
          title={copy ? `${copy.label} this payment?` : ""}
          description={copy?.description}
          summary={
            acting
              ? [
                  { label: "Academy", value: academyNames[acting.payment.academyId] ?? "Unknown academy" },
                  { label: "Amount", value: amountLabel(acting.payment) },
                  { label: "Received", value: formatCalendarDate(acting.payment.receivedAt) },
                ]
              : undefined
          }
          submitLabel={copy?.label ?? ""}
          pendingLabel="Working…"
          danger={acting?.kind !== "verify"}
          rules={REASON_RULES}
          run={async (data) => {
            if (!acting) return null;
            const result = await REASON_ACTION[acting.kind](acting.payment.id, String(data.get("reason") ?? ""));
            return result.ok ? null : result.error.message;
          }}
          onDone={() => {
            if (copy) showSuccessToast(`Payment ${copy.past}.`);
            setActing(null);
          }}
        >
          {({ errors, blur }) => <ReasonField errors={errors} blur={blur} />}
        </ActionDialog>
      )}
    </>
  );
}

function RecordPaymentButton({ subscriptionOptions }: { subscriptionOptions: AcademySubscriptionOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Record payment
      </Button>
      <DesignDialog
        open={open}
        onOpenChange={setOpen}
        title="Record payment"
        description="The payment is saved as pending until the platform owner verifies it."
        width={640}
      >
        {open && <RecordPaymentForm subscriptionOptions={subscriptionOptions} onDone={() => setOpen(false)} />}
      </DesignDialog>
    </>
  );
}

const RECORD_RULES: DesignFormRule[] = [
  { name: "subscriptionId", label: "Academy subscription", required: true, kind: "select" },
  {
    name: "amountDollars",
    label: "Amount",
    required: true,
    check: (value) =>
      /^\d+(\.\d{1,2})?$/.test(value.trim()) && Number(value) > 0 ? null : "Enter an amount above 0, like 129 or 129.00.",
  },
  {
    name: "currency",
    label: "Currency",
    required: true,
    check: (value) => (/^[A-Za-z]{3}$/.test(value.trim()) ? null : "Use a 3-letter code, for example USD."),
  },
  { name: "paymentMethod", label: "Payment method", required: true },
  { name: "receivedAt", label: "Received date", required: true },
];

function RecordPaymentForm({
  subscriptionOptions,
  onDone,
}: {
  subscriptionOptions: AcademySubscriptionOption[];
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(guardedRecord, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(RECORD_RULES);
  const [subscriptionId, setSubscriptionId] = useState("");
  const selected = subscriptionOptions.find((option) => option.subscriptionId === subscriptionId);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Payment recorded.");
      onDone();
    } else if (state.error) {
      showServerError(state.error.message, [
        [/subscription|academy/i, "subscriptionId"],
        [/amount/i, "amountDollars"],
        [/currency/i, "currency"],
        [/method/i, "paymentMethod"],
        [/received|date/i, "receivedAt"],
      ]);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const text = (name: string, label: string, options: { required?: boolean; placeholder?: string; full?: boolean; type?: string; defaultValue?: string; maxLength?: number; hint?: string } = {}) => (
    <DField label={label} name={name} required={options.required} error={errors[name]} full={options.full} hint={options.hint}>
      <input
        type={options.type ?? "text"}
        name={name}
        defaultValue={options.defaultValue}
        maxLength={options.maxLength}
        placeholder={options.placeholder}
        onBlur={options.required ? blur(name) : undefined}
        className={controlClass(Boolean(errors[name]))}
        {...invalidProps(name, errors[name])}
      />
    </DField>
  );

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => {
        data.set("currency", String(data.get("currency") ?? "").trim().toUpperCase());
        startTransition(() => formAction(data));
      })}
    >
      <input type="hidden" name="academyId" value={selected?.academyId ?? ""} />
      <DialogBody>
        <FieldGrid>
          <DField label="Academy subscription" name="subscriptionId" required error={errors.subscriptionId} full>
            <select
              name="subscriptionId"
              value={subscriptionId}
              onChange={(event) => setSubscriptionId(event.target.value)}
              onBlur={blur("subscriptionId")}
              className={controlClass(Boolean(errors.subscriptionId))}
              {...invalidProps("subscriptionId", errors.subscriptionId)}
            >
              <option value="">Select a subscription</option>
              {subscriptionOptions.map((option) => (
                <option key={option.subscriptionId} value={option.subscriptionId}>
                  {option.academyName} — {option.planName} ({option.status})
                </option>
              ))}
            </select>
          </DField>
          {text("amountDollars", "Amount", { required: true, placeholder: "0.00", hint: "Entered in dollars, stored in cents." })}
          {text("currency", "Currency", { required: true, defaultValue: "USD", maxLength: 3 })}
          {text("paymentMethod", "Payment method", { required: true, placeholder: "Bank transfer, EVC Plus, cash…" })}
          {text("receivedAt", "Received date", { required: true, type: "date" })}
          {text("paymentReference", "Reference", { placeholder: "Transaction or receipt number" })}
          {text("evidenceFileRef", "Evidence reference", { hint: "A file reference; there is no upload storage yet." })}
          <DField label="Notes" name="notes" full>
            <textarea name="notes" rows={3} maxLength={1000} className={controlClass(false, true)} />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onDone} submitLabel="Record payment" pendingLabel="Recording…" pending={pending} />
    </form>
  );
}
