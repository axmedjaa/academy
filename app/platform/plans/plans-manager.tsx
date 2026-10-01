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
  FormDialog,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { centsToDollars } from "@/lib/ui/money";

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
                <PlanRow key={plan.id} plan={plan} onEdit={() => setSelectedPlanId(plan.id)} />
              ))}
            </tbody>
          </TableWrap>
        )}
      </div>

      {selectedPlan && (
        <FormDialog
          open={selectedPlan !== null}
          onOpenChange={(nextOpen) => !nextOpen && setSelectedPlanId("")}
          title={`Edit plan: ${selectedPlan.name}`}
          className="max-w-xl"
        >
          {/* key forces a remount (fresh useActionState) when switching
              which plan is being edited, rather than reusing stale state
              from a previously selected plan's submission. */}
          <PlanForm
            mode="edit"
            plan={selectedPlan}
            key={selectedPlan.id}
            onSuccess={() => setSelectedPlanId("")}
            onCancel={() => setSelectedPlanId("")}
          />
        </FormDialog>
      )}
    </div>
  );
}

function PlanRow({
  plan,
  onEdit,
}: {
  plan: SubscriptionPlanRecord;
  onEdit: () => void;
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Actions for ${plan.name}`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-app hover:text-ink motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <Icon name="more" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
              <DropdownMenuItem disabled={isPending} onClick={toggleActive}>
                {plan.isActive ? "Retire" : "Restore"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
  onSuccess,
  onCancel,
}: {
  mode: "create" | "edit";
  plan?: SubscriptionPlanRecord;
  /** Edit mode only — auto-closes the FormDialog once the save succeeds,
   * the functional equivalent of "redirect back to the list" (see
   * app/academy/branches/branches-list.tsx's identical pattern). Create
   * mode has no dialog to close, so it's never passed there. */
  onSuccess?: () => void;
  /** Edit mode only — closes the dialog without saving, same as every
   * other FormDialog-wrapped edit form's own Cancel button. */
  onCancel?: () => void;
}) {
  const action = mode === "create" ? createSubscriptionPlan : updateSubscriptionPlan;
  const [state, formAction, pending] = useActionState(action, initialState);

  const [prevOk, setPrevOk] = useState(state.ok);
  if (state.ok !== prevOk) {
    setPrevOk(state.ok);
    if (state.ok) onSuccess?.();
  }

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
        <Field label="Price (USD)">
          <input
            type="number"
            name="priceDollars"
            min={0}
            step="0.01"
            placeholder="0.00"
            required
            defaultValue={plan ? centsToDollars(plan.priceAmountCents) : undefined}
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

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : mode === "create" ? "Create plan" : "Save changes"}
        </Button>
        {mode === "edit" && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
