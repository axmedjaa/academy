"use client";

import { startTransition, useActionState, useEffect, useState, useTransition } from "react";
import { createSubscriptionPlan, updateSubscriptionPlan, setPlanActive, type PlanFormState } from "@/lib/subscriptions/plans-actions";
import type { SubscriptionPlanRecord } from "@/lib/subscriptions/plans";
import { guardAction, NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { centsToDollars, formatMoney } from "@/lib/ui/money";
import { Badge, Button, EmptyState, Section } from "@/app/academy/_shell/ui";
import { ClearFilters, FilterSelect, SearchField } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";
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

const guardedCreate = guardAction(createSubscriptionPlan);
const guardedUpdate = guardAction(updateSubscriptionPlan);
const initialState: PlanFormState = { ok: false };

const BILLING_PERIODS = [
  { value: "monthly", label: "Monthly", per: "per month" },
  { value: "quarterly", label: "Quarterly", per: "per quarter" },
  { value: "annual", label: "Annual", per: "per year" },
] as const;
const REPORTS_LEVELS = [
  { value: "none", label: "No reports" },
  { value: "basic", label: "Basic reports" },
  { value: "advanced", label: "Advanced reports" },
] as const;

const GB = 1024 ** 3;
const formatGb = (bytes: number) => {
  const gb = bytes / GB;
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(gb < 1 ? 2 : 1);
};

const wholeNumber = (label: string) => (value: string) =>
  /^\d+$/.test(value.trim()) ? null : `${label} must be a whole number, 0 or more.`;

const RULES: DesignFormRule[] = [
  { name: "name", label: "Plan name", required: true },
  {
    name: "priceDollars",
    label: "Price",
    required: true,
    check: (value) => (/^\d+(\.\d{1,2})?$/.test(value.trim()) ? null : "Enter a price like 49 or 49.00."),
  },
  {
    name: "currency",
    label: "Currency",
    required: true,
    check: (value) => (/^[A-Za-z]{3}$/.test(value.trim()) ? null : "Use a 3-letter code, for example USD."),
  },
  { name: "maxBranches", label: "Branches", required: true, check: wholeNumber("Branches") },
  { name: "maxStudents", label: "Students", required: true, check: wholeNumber("Students") },
  { name: "maxStaff", label: "Staff", required: true, check: wholeNumber("Staff") },
  { name: "maxCourses", label: "Courses", required: true, check: wholeNumber("Courses") },
  {
    name: "maxStorageGb",
    label: "Storage",
    required: true,
    check: (value) => (/^\d+(\.\d{1,2})?$/.test(value.trim()) ? null : "Enter storage in GB, for example 2 or 0.5."),
  },
];

/** Header action: opens the Create plan dialog (design P06). */
export function CreatePlanButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Create plan
      </Button>
      <DesignDialog open={open} onOpenChange={setOpen} title="Create plan" description="Prices are stored in cents; allowances apply to new subscriptions on this plan." width={640}>
        {open && <PlanForm mode="create" onDone={() => setOpen(false)} />}
      </DesignDialog>
    </>
  );
}

/**
 * Plans (design P06): a card per plan with its price, allowances and
 * features, and Edit / Retire / Restore. Plans are never deleted; Retire
 * and Restore only change whether the plan can be chosen for new
 * subscriptions (the existing `setPlanActive`), Edit never changes it.
 */
const PLAN_FILTER_PARAMS = ["q", "status", "price"];

/** Design P06 filter bar: search by name, Status, Price, Clear filters. */
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
  filtersActive,
  matchingCount,
  overallCount,
}: {
  plans: SubscriptionPlanRecord[];
  /** Whether any filter is applied (drives the empty-state wording). */
  filtersActive: boolean;
  /** Plans matching the filters, across all pages. */
  matchingCount: number;
  /** Every plan, unfiltered. */
  overallCount: number;
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
        Showing {matchingCount.toLocaleString("en-US")} of {overallCount.toLocaleString("en-US")} plan{overallCount === 1 ? "" : "s"}
      </p>
      {plans.length === 0 && filtersActive && (
        <div className="mb-8 rounded-card border border-border bg-surface px-4 py-10 text-center text-[#374151]">
          No plans match these filters. <ClearFilters params={PLAN_FILTER_PARAMS} compact />
        </div>
      )}
      <div className="mb-4">
        {/* Design P06 grid: as many 260px-minimum columns as fit, 24px gap
            (auto-fill, so a single result keeps card width). */}
        <ul role="list" className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-6">
          {plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} onEdit={() => setEditingId(plan.id)} />
          ))}
        </ul>
      </div>
      <DesignDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditingId("")}
        title={editing ? `Edit ${editing.name}` : "Edit plan"}
        description="Editing never changes whether the plan is active."
        width={640}
      >
        {editing && <PlanForm key={editing.id} mode="edit" plan={editing} onDone={() => setEditingId("")} />}
      </DesignDialog>
    </>
  );
}

function PlanCard({ plan, onEdit }: { plan: SubscriptionPlanRecord; onEdit: () => void }) {
  const [pending, startToggle] = useTransition();
  const per = BILLING_PERIODS.find((period) => period.value === plan.billingPeriod)?.per ?? plan.billingPeriod;
  const features = [
    plan.emailEnabled ? "Email" : null,
    plan.smsEnabled ? "SMS" : null,
    plan.certificateEnabled ? "Certificates" : null,
    REPORTS_LEVELS.find((level) => level.value === plan.reportsLevel)?.label ?? null,
  ].filter(Boolean) as string[];

  function toggle() {
    startToggle(async () => {
      try {
        const result = await setPlanActive(plan.id, !plan.isActive);
        if (!result.ok) showErrorToast(result.error.message);
        else showSuccessToast(plan.isActive ? "Plan retired." : "Plan restored.");
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  const rows: [string, string][] = [
    ["Branches", plan.maxBranches.toLocaleString("en-US")],
    ["Students", plan.maxStudents.toLocaleString("en-US")],
    ["Staff", plan.maxStaff.toLocaleString("en-US")],
    ["Courses", plan.maxCourses.toLocaleString("en-US")],
    ["Storage (GB)", formatGb(plan.maxStorageBytes)],
  ];

  return (
    <li className={`flex min-w-0 flex-col rounded-card border border-border bg-surface p-5 shadow-card ${plan.isActive ? "" : "opacity-85"}`}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 text-[17px] font-semibold leading-snug text-ink [overflow-wrap:anywhere]">{plan.name}</h2>
        <Badge label={plan.isActive ? "Active" : "Retired"} tone={plan.isActive ? "green" : "slate"} />
      </div>
      <p className="mt-2">
        <span className="text-[30px] font-bold leading-none tracking-[-0.01em] text-brand tabular-nums">
          {formatMoney(plan.priceAmountCents, plan.currency)}
        </span>{" "}
        <span className="text-sm text-muted">{per}</span>
      </p>
      {plan.description && <p className="mt-2 line-clamp-2 text-[13px] text-muted">{plan.description}</p>}
      <dl className="mt-4 divide-y divide-border border-y border-border text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-3 py-2.5">
            <dt className="text-[#374151]">{label}</dt>
            <dd className="font-semibold tabular-nums text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      {features.length > 0 && (
        <p className="mt-3 flex flex-wrap gap-1.5">
          {features.map((feature) => (
            <span key={feature} className="rounded-full bg-app px-2.5 py-0.5 text-xs font-medium text-[#374151]">
              {feature}
            </span>
          ))}
        </p>
      )}
      <div className="mt-auto flex gap-2 pt-4">
        <button type="button" onClick={onEdit} className={`${ROW_BTN} flex-1 justify-center`}>
          Edit plan
        </button>
        <button type="button" onClick={toggle} disabled={pending} className={`${ROW_BTN} flex-1 justify-center`}>
          {pending ? "Saving…" : plan.isActive ? "Retire plan" : "Restore plan"}
        </button>
      </div>
    </li>
  );
}

function PlanForm({ mode, plan, onDone }: { mode: "create" | "edit"; plan?: SubscriptionPlanRecord; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(mode === "create" ? guardedCreate : guardedUpdate, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(RULES);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast(mode === "create" ? "Plan created." : "Plan updated.");
      onDone();
    } else if (state.error) {
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

  const number = (name: string, label: string, defaultValue: number | string, hint?: string) => (
    <DField label={label} name={name} required error={errors[name]} hint={hint}>
      <input
        type="text"
        inputMode="decimal"
        name={name}
        defaultValue={defaultValue}
        onBlur={blur(name)}
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
        // Storage is entered in GB and stored in bytes (the action's field).
        data.set("maxStorageBytes", String(Math.round(Number(data.get("maxStorageGb")) * GB)));
        data.delete("maxStorageGb");
        data.set("currency", String(data.get("currency") ?? "").trim().toUpperCase());
        startTransition(() => formAction(data));
      })}
    >
      {mode === "edit" && plan && <input type="hidden" name="planId" value={plan.id} />}
      <DialogBody>
        <FieldGrid>
          <DField label="Plan name" name="name" required error={errors.name} full>
            <input
              type="text"
              name="name"
              defaultValue={plan?.name}
              placeholder="Growth"
              onBlur={blur("name")}
              className={controlClass(Boolean(errors.name))}
              {...invalidProps("name", errors.name)}
            />
          </DField>
          <DField label="Description" name="description" full>
            <textarea name="description" rows={2} defaultValue={plan?.description ?? ""} className={`${controlClass(false)} h-auto py-2.5`} />
          </DField>
          {number("priceDollars", "Price", plan ? centsToDollars(plan.priceAmountCents) : "", "Entered in dollars, stored in cents.")}
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
          <DField label="Reports" name="reportsLevel" required>
            <select name="reportsLevel" defaultValue={plan?.reportsLevel ?? "basic"} className={controlClass(false)}>
              {REPORTS_LEVELS.map((level) => (
                <option key={level.value} value={level.value}>
                  {level.label}
                </option>
              ))}
            </select>
          </DField>
          {number("maxBranches", "Branches", plan?.maxBranches ?? 1)}
          {number("maxStudents", "Students", plan?.maxStudents ?? 100)}
          {number("maxStaff", "Staff", plan?.maxStaff ?? 10)}
          {number("maxCourses", "Courses", plan?.maxCourses ?? 10)}
          {number("maxStorageGb", "Storage (GB)", plan ? formatGb(plan.maxStorageBytes) : 1)}
          <fieldset className="col-span-full flex flex-wrap gap-x-6 gap-y-2 rounded-lg border border-border bg-app px-4 py-3">
            <legend className="px-1 text-[13px] font-semibold text-ink">Features</legend>
            {[
              ["emailEnabled", "Email", plan?.emailEnabled ?? true],
              ["smsEnabled", "SMS", plan?.smsEnabled ?? false],
              ["certificateEnabled", "Certificates", plan?.certificateEnabled ?? false],
            ].map(([name, label, checked]) => (
              <label key={name as string} className="flex min-h-10 items-center gap-2 text-sm text-ink">
                <input type="checkbox" name={name as string} defaultChecked={checked as boolean} className="h-[18px] w-[18px] accent-brand" />
                {label as string}
              </label>
            ))}
          </fieldset>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={onDone}
        submitLabel={mode === "create" ? "Create plan" : "Save changes"}
        pendingLabel="Saving…"
        pending={pending}
      />
    </form>
  );
}
