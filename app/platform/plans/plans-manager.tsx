"use client";

import { startTransition, useActionState, useEffect, useState, useTransition } from "react";
import {
  createSubscriptionPlan,
  movePlan,
  setPlanActive,
  updateSubscriptionPlan,
  type PlanFormState,
} from "@/lib/subscriptions/plans-actions";
import type { PlanLimitImpact, SubscriptionPlanRecord } from "@/lib/subscriptions/plans";
import { PLAN_FEATURES, PLAN_LIMITS, formatLimit, type PlanLimitKey } from "@/lib/subscriptions/plan-catalog";
import { guardAction, NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { centsToDollars, formatMoney } from "@/lib/ui/money";
import { Badge, Button, EmptyState, Section } from "@/app/academy/_shell/ui";
import { ClearFilters, FilterSelect, SearchField } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";

/**
 * Platform -> Plans. Every plan name, price, limit and feature shown or
 * edited here comes from subscription_plans; the vocabulary of limits and
 * features comes from lib/subscriptions/plan-catalog.ts, which the server
 * enforces. Plans are never deleted: retiring only stops new subscriptions.
 */

const guardedCreate = guardAction(createSubscriptionPlan);
const guardedUpdate = guardAction(updateSubscriptionPlan);
const initialState: PlanFormState = { ok: false };

const BILLING_PERIODS = [
  { value: "monthly", label: "Monthly", per: "per month" },
  { value: "quarterly", label: "Quarterly", per: "per quarter" },
  { value: "annual", label: "Annual", per: "per year" },
] as const;

const GB = 1024 ** 3;
const toGbInput = (bytes: number) => {
  const gb = bytes / GB;
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(gb < 1 ? 2 : 1);
};

const unlimited = (data: FormData, key: PlanLimitKey) => data.get(`${key}Unlimited`) === "on";

const RULES: DesignFormRule[] = [
  { name: "name", label: "Plan name", required: true },
  {
    name: "priceDollars",
    label: "Price",
    check: (value) =>
      value.trim() === "" || /^\d+(\.\d{1,2})?$/.test(value.trim()) ? null : "Enter a price like 49 or 49.00, or leave it empty.",
  },
  {
    name: "currency",
    label: "Currency",
    required: true,
    check: (value) => (/^[A-Za-z]{3}$/.test(value.trim()) ? null : "Use a 3-letter code, for example USD."),
  },
  ...PLAN_LIMITS.map<DesignFormRule>((limit) => ({
    name: limit.key === "maxStorageBytes" ? "maxStorageGb" : limit.key,
    label: limit.label,
    check: (value, data) => {
      if (unlimited(data, limit.key)) return null;
      if (limit.unit === "bytes") {
        return /^\d+(\.\d{1,2})?$/.test(value.trim()) ? null : "Enter storage in GB (for example 2 or 0.5), or choose Unlimited.";
      }
      return /^\d+$/.test(value.trim()) ? null : `${limit.label} must be a whole number, 0 or more, or Unlimited.`;
    },
  })),
];

/** Header action: Create plan. */
export function CreatePlanButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Create plan
      </Button>
      <DesignDialog
        open={open}
        onOpenChange={setOpen}
        title="Create plan"
        description="A plan without a price is saved as retired, and can be activated once it's priced."
        width={720}
      >
        {open && <PlanForm mode="create" onDone={() => setOpen(false)} />}
      </DesignDialog>
    </>
  );
}

const PLAN_FILTER_PARAMS = ["q", "status", "price"];

function PlanFilters() {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <SearchField placeholder="Search plans by name" />
      <FilterSelect
        param="status"
        label="Filter by status"
        options={[
          { value: "", label: "All statuses" },
          { value: "active", label: "Active" },
          { value: "retired", label: "Retired" },
        ]}
      />
      <FilterSelect
        param="price"
        label="Filter by price"
        options={[
          { value: "", label: "Any price" },
          { value: "low", label: "Under $100" },
          { value: "mid", label: "$100 to $199" },
          { value: "high", label: "$200 and up" },
        ]}
      />
      <ClearFilters params={PLAN_FILTER_PARAMS} compact />
    </div>
  );
}

export function PlansManager({
  plans,
  subscriberCounts,
  filtersActive,
  matchingCount,
  overallCount,
  canReorder,
}: {
  plans: SubscriptionPlanRecord[];
  /** Academies currently on each plan, by plan id. */
  subscriberCounts: Record<string, number>;
  filtersActive: boolean;
  matchingCount: number;
  overallCount: number;
  /** Reordering is only offered on the unfiltered first page. */
  canReorder: boolean;
}) {
  const [editingId, setEditingId] = useState("");
  const editing = plans.find((plan) => plan.id === editingId) ?? null;

  if (overallCount === 0) {
    return (
      <Section className="mb-8">
        <EmptyState message="No plans yet. Create the first plan to offer it to academies." icon={<Icon name="layers" />} />
      </Section>
    );
  }

  return (
    <>
      <PlanFilters />
      <p className="mb-3 text-[13px] text-muted" aria-live="polite">
        Showing {matchingCount.toLocaleString("en-US")} of {overallCount.toLocaleString("en-US")} plan
        {overallCount === 1 ? "" : "s"}. Plans appear in this order on the website.
      </p>
      {plans.length === 0 && filtersActive && (
        <div className="mb-8 rounded-card border border-border bg-surface px-4 py-10 text-center text-[#374151]">
          No plans match these filters. <ClearFilters params={PLAN_FILTER_PARAMS} compact />
        </div>
      )}
      <ul role="list" className="mb-4 grid grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))] gap-6">
        {plans.map((plan, index) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            subscribers={subscriberCounts[plan.id] ?? 0}
            canMoveUp={canReorder && index > 0}
            canMoveDown={canReorder && index < plans.length - 1}
            onEdit={() => setEditingId(plan.id)}
          />
        ))}
      </ul>
      <DesignDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditingId("")}
        title={editing ? `Edit ${editing.name}` : "Edit plan"}
        description="Changes apply at once to every academy on this plan. Editing never changes whether the plan is active."
        width={720}
      >
        {editing && <PlanForm key={editing.id} mode="edit" plan={editing} onDone={() => setEditingId("")} />}
      </DesignDialog>
    </>
  );
}

function PlanCard({
  plan,
  subscribers,
  canMoveUp,
  canMoveDown,
  onEdit,
}: {
  plan: SubscriptionPlanRecord;
  subscribers: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onEdit: () => void;
}) {
  const [pending, startAction] = useTransition();
  const [retireOpen, setRetireOpen] = useState(false);
  const per = BILLING_PERIODS.find((period) => period.value === plan.billingPeriod)?.per ?? plan.billingPeriod;
  const priced = plan.priceAmountCents !== null;

  function run(action: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>, done: string) {
    startAction(async () => {
      try {
        const result = await action();
        if (!result.ok) showErrorToast(result.error.message);
        else showSuccessToast(done);
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  return (
    <li className={`flex min-w-0 flex-col rounded-card border border-border bg-surface p-5 shadow-card ${plan.isActive ? "" : "opacity-90"}`}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 text-[17px] font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{plan.name}</h2>
        <span className="flex flex-none flex-wrap justify-end gap-1.5">
          {!priced && <Badge label="Price not set" tone="amber" />}
          <Badge label={plan.isActive ? "Active" : "Retired"} tone={plan.isActive ? "green" : "slate"} />
        </span>
      </div>
      <p className="mt-2">
        {priced ? (
          <>
            <span className="text-[30px] font-bold leading-none tracking-[-0.01em] text-brand tabular-nums">
              {formatMoney(plan.priceAmountCents as number, plan.currency)}
            </span>{" "}
            <span className="text-sm text-muted">{per}</span>
          </>
        ) : (
          <span className="text-sm text-[#374151]">Set a price to offer this plan.</span>
        )}
      </p>
      {plan.description && <p className="mt-2 line-clamp-2 text-[13px] text-muted">{plan.description}</p>}
      <p className="mt-3 text-[13px] text-[#374151]">
        <span className="font-semibold text-ink tabular-nums">{subscribers.toLocaleString("en-US")}</span>{" "}
        {subscribers === 1 ? "academy" : "academies"} on this plan
      </p>
      <dl className="mt-3 divide-y divide-border border-y border-border text-sm">
        {PLAN_LIMITS.map((limit) => (
          <div key={limit.key} className="flex items-center justify-between gap-3 py-2">
            <dt className="text-[#374151]">{limit.label}</dt>
            <dd className="font-semibold tabular-nums text-ink">{formatLimit(limit.unit, plan[limit.key])}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-3 grid gap-1.5 text-[13px]" aria-label={`${plan.name} features`}>
        {PLAN_FEATURES.map((feature) => {
          const on = plan[feature.column];
          return (
            <li key={feature.key} className={`flex items-center gap-2 ${on ? "text-ink" : "text-muted"}`}>
              <Icon name={on ? "check_circle" : "cancel"} width={16} height={16} className={on ? "text-success" : "text-muted"} />
              {feature.label}
              <span className="sr-only">{on ? "included" : "not included"}</span>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        <button type="button" onClick={onEdit} className={`${ROW_BTN} flex-1 justify-center`}>
          Edit plan
        </button>
        {plan.isActive ? (
          <button type="button" onClick={() => setRetireOpen(true)} disabled={pending} className={`${ROW_BTN} flex-1 justify-center`}>
            Retire plan
          </button>
        ) : (
          <button
            type="button"
            onClick={() => run(() => setPlanActive(plan.id, true), "Plan activated.")}
            disabled={pending || !priced}
            title={priced ? undefined : "Set a price before activating this plan."}
            className={`${ROW_BTN} flex-1 justify-center`}
          >
            {pending ? "Saving…" : "Activate plan"}
          </button>
        )}
        {(canMoveUp || canMoveDown) && (
          <span className="flex gap-2">
            <button
              type="button"
              aria-label={`Move ${plan.name} earlier`}
              title="Move earlier"
              disabled={!canMoveUp || pending}
              onClick={() => run(() => movePlan(plan.id, "up"), "Order updated.")}
              className={`${ROW_BTN} w-10 justify-center px-0`}
            >
              <Icon name="expand_more" width={16} height={16} className="rotate-180" />
            </button>
            <button
              type="button"
              aria-label={`Move ${plan.name} later`}
              title="Move later"
              disabled={!canMoveDown || pending}
              onClick={() => run(() => movePlan(plan.id, "down"), "Order updated.")}
              className={`${ROW_BTN} w-10 justify-center px-0`}
            >
              <Icon name="expand_more" width={16} height={16} />
            </button>
          </span>
        )}
      </div>
      <ConfirmButton
        label="Retire plan"
        open={retireOpen}
        onOpenChange={setRetireOpen}
        title={`Retire ${plan.name}?`}
        description={
          <>
            It disappears from the website and can&apos;t be chosen for new subscriptions. The{" "}
            {subscribers.toLocaleString("en-US")} {subscribers === 1 ? "academy" : "academies"} already on it keep their subscription,
            limits and data. You can activate it again later.
          </>
        }
        onConfirm={() => setPlanActive(plan.id, false)}
      />
    </li>
  );
}

function LimitField({
  limitKey,
  label,
  unit,
  value,
  error,
  onBlur,
}: {
  limitKey: PlanLimitKey;
  label: string;
  unit: "count" | "bytes";
  value: number | null | undefined;
  error?: string;
  onBlur: () => void;
}) {
  const [isUnlimited, setUnlimited] = useState(value === null);
  const name = unit === "bytes" ? "maxStorageGb" : limitKey;
  const initial = value === null || value === undefined ? "" : unit === "bytes" ? toGbInput(value) : String(value);
  return (
    <DField label={unit === "bytes" ? `${label} (GB)` : label} name={name} error={error}>
      <span className="flex items-center gap-3">
        <input
          type="text"
          inputMode="decimal"
          name={name}
          defaultValue={initial}
          disabled={isUnlimited}
          onBlur={onBlur}
          aria-label={unit === "bytes" ? `${label} in GB` : label}
          className={`${controlClass(Boolean(error))} min-w-0 flex-1 disabled:bg-app disabled:text-muted`}
          {...invalidProps(name, error)}
        />
        <label className="flex min-h-11 flex-none items-center gap-2 text-[13px] font-medium text-ink">
          <input
            type="checkbox"
            name={`${limitKey}Unlimited`}
            checked={isUnlimited}
            onChange={(event) => setUnlimited(event.target.checked)}
            className="h-[18px] w-[18px] accent-brand"
          />
          Unlimited
        </label>
      </span>
    </DField>
  );
}

function PlanForm({ mode, plan, onDone }: { mode: "create" | "edit"; plan?: SubscriptionPlanRecord; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(mode === "create" ? guardedCreate : guardedUpdate, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(RULES);
  // The last submitted values, resent with the confirmation flag.
  const [lastSubmitted, setLastSubmitted] = useState<FormData | null>(null);
  // "Keep editing" hides the warning for this particular result.
  const [dismissed, setDismissed] = useState<PlanFormState | null>(null);
  const impact: PlanLimitImpact[] | null =
    state.error?.code === "confirmation_required" && dismissed !== state ? (state.error.impact ?? []) : null;

  useEffect(() => {
    if (state.ok) {
      showSuccessToast(mode === "create" ? "Plan created." : "Plan updated.");
      onDone();
    } else if (state.error && state.error.code !== "confirmation_required") {
      showServerError(state.error.message, [
        [/name/i, "name"],
        [/price|amount/i, "priceDollars"],
        [/currency/i, "currency"],
        [/branch/i, "maxBranches"],
        [/student/i, "maxStudents"],
        [/staff/i, "maxStaff"],
        [/course/i, "maxCourses"],
        [/storage/i, "maxStorageGb"],
      ]);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function submit(data: FormData) {
    // Storage is entered in GB and stored in bytes.
    const gb = String(data.get("maxStorageGb") ?? "").trim();
    data.set("maxStorageBytes", gb === "" ? "" : String(Math.round(Number(gb) * GB)));
    data.delete("maxStorageGb");
    data.set("currency", String(data.get("currency") ?? "").trim().toUpperCase());
    setLastSubmitted(data);
    startTransition(() => formAction(data));
  }

  function confirmReduction() {
    if (!lastSubmitted) return;
    lastSubmitted.set("confirmLimitReduction", "1");
    const data = lastSubmitted;
    startTransition(() => formAction(data));
  }

  const academiesAffected = impact ? new Set(impact.map((row) => row.academyId)).size : 0;

  return (
    <form ref={formRef} noValidate className="flex min-h-0 flex-1 flex-col" onSubmit={onDesignSubmit(validate, submit)}>
      {mode === "edit" && plan && <input type="hidden" name="planId" value={plan.id} />}
      <DialogBody>
        {impact && (
          <div role="alert" className="mb-5 rounded-lg border border-[#FDE68A] bg-warning-bg p-4 text-sm text-ink">
            <p className="font-semibold text-warning">
              {academiesAffected} {academiesAffected === 1 ? "academy is" : "academies are"} already above the new limits
            </p>
            <ul className="mt-2 grid max-h-48 gap-1 overflow-y-auto">
              {impact.map((row) => {
                const limit = PLAN_LIMITS.find((entry) => entry.resource === row.resource)!;
                return (
                  <li key={`${row.academyId}-${row.resource}`}>
                    <span className="font-medium">{row.academyName}</span>: {row.label}{" "}
                    {formatLimit(limit.unit, row.current)} used, new limit {formatLimit(limit.unit, row.newLimit)}
                  </li>
                );
              })}
            </ul>
            <p className="mt-2 text-[#374151]">
              Nothing is deleted and no academy is suspended. They can&apos;t add more of these until they&apos;re under the limit.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={confirmReduction}
                disabled={pending}
                className="h-10 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand-hover disabled:opacity-60"
              >
                Save anyway
              </button>
              <button type="button" onClick={() => setDismissed(state)} className={ROW_BTN}>
                Keep editing
              </button>
            </div>
          </div>
        )}
        <FieldGrid>
          <DField label="Plan name" name="name" required error={errors.name} full>
            <input
              type="text"
              name="name"
              defaultValue={plan?.name}
              placeholder="Professional"
              onBlur={blur("name")}
              className={controlClass(Boolean(errors.name))}
              {...invalidProps("name", errors.name)}
            />
          </DField>
          <DField label="Description" name="description" full hint="Shown under the plan name on the website.">
            <textarea name="description" rows={2} defaultValue={plan?.description ?? ""} className={`${controlClass(false)} h-auto py-2.5`} />
          </DField>
          <DField
            label="Price"
            name="priceDollars"
            error={errors.priceDollars}
            hint={plan?.isActive ? "Active plans need a price." : "Leave empty to keep the plan retired until it's priced."}
          >
            <input
              type="text"
              inputMode="decimal"
              name="priceDollars"
              defaultValue={plan && plan.priceAmountCents !== null ? centsToDollars(plan.priceAmountCents) : ""}
              onBlur={blur("priceDollars")}
              className={controlClass(Boolean(errors.priceDollars))}
              {...invalidProps("priceDollars", errors.priceDollars)}
            />
          </DField>
          <DField label="Currency" name="currency" required error={errors.currency}>
            <input
              type="text"
              name="currency"
              maxLength={3}
              defaultValue={plan?.currency ?? "USD"}
              onBlur={blur("currency")}
              className={`${controlClass(Boolean(errors.currency))} uppercase`}
              {...invalidProps("currency", errors.currency)}
            />
          </DField>
          <DField label="Billing period" name="billingPeriod" required>
            <select name="billingPeriod" defaultValue={plan?.billingPeriod ?? "monthly"} className={controlClass(false)}>
              {BILLING_PERIODS.map((period) => (
                <option key={period.value} value={period.value}>
                  {period.label}
                </option>
              ))}
            </select>
          </DField>
        </FieldGrid>

        <fieldset className="mt-6 min-w-0 border-0 p-0">
          <legend className="mb-1 text-[15px] font-semibold text-ink">Resource limits</legend>
          <p className="mb-4 text-[13px] text-muted">
            Archived records don&apos;t count. Choose Unlimited for no limit.
          </p>
          <FieldGrid>
            {PLAN_LIMITS.map((limit) => {
              const field = limit.key === "maxStorageBytes" ? "maxStorageGb" : limit.key;
              return (
                <LimitField
                  key={limit.key}
                  limitKey={limit.key}
                  label={limit.label}
                  unit={limit.unit}
                  value={plan ? plan[limit.key] : undefined}
                  error={errors[field]}
                  onBlur={blur(field)}
                />
              );
            })}
          </FieldGrid>
        </fieldset>

        <fieldset className="mt-6 min-w-0 border-0 p-0">
          <legend className="mb-1 text-[15px] font-semibold text-ink">Features</legend>
          <p className="mb-3 text-[13px] text-muted">
            Core academy operations, certificates and security are on every plan.
          </p>
          <div className="grid gap-2">
            {PLAN_FEATURES.map((feature) => (
              <label
                key={feature.key}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3 has-[:checked]:border-brand has-[:checked]:bg-brand-tint"
              >
                <input
                  type="checkbox"
                  name={feature.column}
                  defaultChecked={plan ? plan[feature.column] : feature.key !== "sms"}
                  className="mt-0.5 h-[18px] w-[18px] flex-none accent-brand"
                />
                <span>
                  <span className="block text-sm font-semibold text-ink">{feature.label}</span>
                  <span className="block text-[13px] text-[#374151]">{feature.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={onDone}
        submitLabel={mode === "create" ? "Create plan" : "Save changes"}
        pendingLabel="Saving…"
        pending={pending}
        disabled={impact !== null}
      />
    </form>
  );
}
