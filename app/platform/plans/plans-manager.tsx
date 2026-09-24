"use client";

import { useActionState, useState, useTransition } from "react";
import {
  createSubscriptionPlan,
  updateSubscriptionPlan,
  setPlanActive,
  type PlanFormState,
} from "@/lib/subscriptions/plans-actions";
import type { SubscriptionPlanRecord } from "@/lib/subscriptions/plans";
import {
  Badge,
  Button,
  ErrorMessage,
  Field,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";

const initialState: PlanFormState = { ok: false };

const BILLING_PERIODS = ["monthly", "quarterly", "annual"] as const;
const REPORTS_LEVELS = ["none", "basic", "advanced"] as const;

interface Props {
  plans: SubscriptionPlanRecord[];
}

// DESIGN.md §8: "/platform/plans | A + C | List of plan templates +
// create/edit form (name, price, billing period, per-resource limits,
// feature flags); Retire (not delete) if any academy is on it." Follows
// app/platform/staff/platform-staff-manager.tsx's style: useActionState for
// the create/edit forms, useTransition for the Retire/Restore toggle.
export function PlansManager({ plans }: Props) {
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const selectedPlan = plans.find((plan) => plan.id === selectedPlanId) ?? null;

  return (
    <div className="flex flex-col gap-6">
      <Section>
        <h2 className="text-base font-semibold text-ink">Create plan</h2>
        <div className="mt-4">
          <PlanForm mode="create" />
        </div>
      </Section>

      <div>
        <h2 className="mb-3 text-lg font-semibold text-ink">Plan templates</h2>
        {plans.length === 0 ? (
          <Section>
            <p className="text-sm text-muted">No plans yet — create one above.</p>
          </Section>
        ) : (
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Name</th>
                <th className={th}>Price</th>
                <th className={th}>Billing</th>
                <th className={th}>Reports</th>
                <th className={th}>Status</th>
                <th className={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <PlanRow
                  key={plan.id}
                  plan={plan}
                  isSelected={plan.id === selectedPlanId}
                  onToggleEdit={() =>
                    setSelectedPlanId((current) =>
                      current === plan.id ? "" : plan.id,
                    )
                  }
                />
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>

      {selectedPlan && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Edit plan: {selectedPlan.name}</h2>
          <div className="mt-4">
            {/* key forces a remount (fresh useActionState) when switching
                which plan is being edited, rather than reusing stale state
                from a previously selected plan's submission. */}
            <PlanForm mode="edit" plan={selectedPlan} key={selectedPlan.id} />
          </div>
        </Section>
      )}
    </div>
  );
}

function PlanRow({
  plan,
  isSelected,
  onToggleEdit,
}: {
  plan: SubscriptionPlanRecord;
  isSelected: boolean;
  onToggleEdit: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggleActive() {
    setError(null);
    startTransition(async () => {
      const result = await setPlanActive(plan.id, !plan.isActive);
      if (!result.ok) {
        setError(result.error.message);
      }
    });
  }

  return (
    <>
      <tr className={trHover}>
        <td className={`${td} font-medium`}>{plan.name}</td>
        <td className={td}>
          {(plan.priceAmountCents / 100).toFixed(2)} {plan.currency}
        </td>
        <td className={td}>{plan.billingPeriod}</td>
        <td className={td}>{plan.reportsLevel}</td>
        <td className={td}>
          <Badge label={plan.isActive ? "Active" : "Retired"} tone={plan.isActive ? "green" : "gray"} />
        </td>
        <td className={td}>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" className="px-2.5 py-1 text-xs" onClick={onToggleEdit}>
              {isSelected ? "Close" : "Edit"}
            </Button>
            <Button
              type="button"
              variant={plan.isActive ? "danger" : "secondary"}
              className="px-2.5 py-1 text-xs"
              disabled={isPending}
              onClick={toggleActive}
            >
              {plan.isActive ? "Retire" : "Restore"}
            </Button>
          </div>
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={6} className={td}>
            <ErrorMessage message={error} />
          </td>
        </tr>
      )}
    </>
  );
}

function PlanForm({
  mode,
  plan,
}: {
  mode: "create" | "edit";
  plan?: SubscriptionPlanRecord;
}) {
  const action = mode === "create" ? createSubscriptionPlan : updateSubscriptionPlan;
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="flex max-w-xl flex-col gap-3">
      {mode === "edit" && plan && (
        <input type="hidden" name="planId" value={plan.id} />
      )}

      <Field label="Name">
        <input type="text" name="name" required defaultValue={plan?.name} className={inputClass} />
      </Field>

      <Field label="Description">
        <textarea name="description" defaultValue={plan?.description ?? ""} rows={3} className={inputClass} />
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Price (in cents)">
          <input
            type="number"
            name="priceAmountCents"
            min={0}
            step={1}
            required
            defaultValue={plan?.priceAmountCents ?? 0}
            className={inputClass}
          />
        </Field>
        <Field label="Currency (3-letter code)">
          <input
            type="text"
            name="currency"
            maxLength={3}
            required
            defaultValue={plan?.currency ?? "USD"}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Billing period">
        <select name="billingPeriod" defaultValue={plan?.billingPeriod ?? "monthly"} className={inputClass}>
          {BILLING_PERIODS.map((period) => (
            <option key={period} value={period}>
              {period}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Max branches">
          <input
            type="number"
            name="maxBranches"
            min={0}
            step={1}
            required
            defaultValue={plan?.maxBranches ?? 1}
            className={inputClass}
          />
        </Field>
        <Field label="Max students">
          <input
            type="number"
            name="maxStudents"
            min={0}
            step={1}
            required
            defaultValue={plan?.maxStudents ?? 100}
            className={inputClass}
          />
        </Field>
        <Field label="Max staff">
          <input
            type="number"
            name="maxStaff"
            min={0}
            step={1}
            required
            defaultValue={plan?.maxStaff ?? 10}
            className={inputClass}
          />
        </Field>
        <Field label="Max courses">
          <input
            type="number"
            name="maxCourses"
            min={0}
            step={1}
            required
            defaultValue={plan?.maxCourses ?? 10}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Max storage (bytes)">
        <input
          type="number"
          name="maxStorageBytes"
          min={0}
          step={1}
          required
          defaultValue={plan?.maxStorageBytes ?? 1073741824}
          className={inputClass}
        />
      </Field>

      <Field label="Reports level">
        <select name="reportsLevel" defaultValue={plan?.reportsLevel ?? "basic"} className={inputClass}>
          {REPORTS_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex flex-col gap-2 rounded-control border border-border bg-app px-3 py-3">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="smsEnabled" defaultChecked={plan?.smsEnabled ?? false} />
          SMS enabled
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="emailEnabled" defaultChecked={plan?.emailEnabled ?? true} />
          Email enabled
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" name="certificateEnabled" defaultChecked={plan?.certificateEnabled ?? false} />
          Certificates enabled
        </label>
      </div>

      {state.error && <ErrorMessage message={state.error.message} />}
      {state.ok && <p className="text-sm font-medium text-success">Saved.</p>}

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Saving..." : mode === "create" ? "Create plan" : "Save changes"}
      </Button>
    </form>
  );
}
