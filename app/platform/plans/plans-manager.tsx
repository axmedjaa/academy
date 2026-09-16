"use client";

import { useActionState, useState, useTransition } from "react";
import {
  createSubscriptionPlan,
  updateSubscriptionPlan,
  setPlanActive,
  type PlanFormState,
} from "@/lib/subscriptions/plans-actions";
import type { SubscriptionPlanRecord } from "@/lib/subscriptions/plans";

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
    <div style={{ display: "flex", flexDirection: "column", gap: "2.5rem" }}>
      <section>
        <h2>Create plan</h2>
        <PlanForm mode="create" />
      </section>

      <section>
        <h2>Plan templates</h2>
        {plans.length === 0 ? (
          <p>No plans yet — create one above.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Name</th>
                <th style={{ textAlign: "left" }}>Price</th>
                <th style={{ textAlign: "left" }}>Billing</th>
                <th style={{ textAlign: "left" }}>Reports</th>
                <th style={{ textAlign: "left" }}>Status</th>
                <th style={{ textAlign: "left" }}>Actions</th>
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
          </table>
        )}
      </section>

      {selectedPlan && (
        <section>
          <h2>Edit plan: {selectedPlan.name}</h2>
          {/* key forces a remount (fresh useActionState) when switching
              which plan is being edited, rather than reusing stale state
              from a previously selected plan's submission. */}
          <PlanForm mode="edit" plan={selectedPlan} key={selectedPlan.id} />
        </section>
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
      <tr>
        <td>{plan.name}</td>
        <td>
          {(plan.priceAmountCents / 100).toFixed(2)} {plan.currency}
        </td>
        <td>{plan.billingPeriod}</td>
        <td>{plan.reportsLevel}</td>
        <td>{plan.isActive ? "Active" : "Retired"}</td>
        <td>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" onClick={onToggleEdit}>
              {isSelected ? "Close" : "Edit"}
            </button>
            <button type="button" disabled={isPending} onClick={toggleActive}>
              {plan.isActive ? "Retire" : "Restore"}
            </button>
          </div>
        </td>
      </tr>
      {error && (
        <tr>
          <td colSpan={6} role="alert" style={{ color: "crimson" }}>
            {error}
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
    <form
      action={formAction}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        maxWidth: 480,
      }}
    >
      {mode === "edit" && plan && (
        <input type="hidden" name="planId" value={plan.id} />
      )}

      <label>
        Name
        <input
          type="text"
          name="name"
          required
          defaultValue={plan?.name}
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Description
        <textarea
          name="description"
          defaultValue={plan?.description ?? ""}
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Price (in cents)
        <input
          type="number"
          name="priceAmountCents"
          min={0}
          step={1}
          required
          defaultValue={plan?.priceAmountCents ?? 0}
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Currency (3-letter code)
        <input
          type="text"
          name="currency"
          maxLength={3}
          required
          defaultValue={plan?.currency ?? "USD"}
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Billing period
        <select
          name="billingPeriod"
          defaultValue={plan?.billingPeriod ?? "monthly"}
          style={{ display: "block", width: "100%" }}
        >
          {BILLING_PERIODS.map((period) => (
            <option key={period} value={period}>
              {period}
            </option>
          ))}
        </select>
      </label>

      <label>
        Max branches
        <input
          type="number"
          name="maxBranches"
          min={0}
          step={1}
          required
          defaultValue={plan?.maxBranches ?? 1}
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Max students
        <input
          type="number"
          name="maxStudents"
          min={0}
          step={1}
          required
          defaultValue={plan?.maxStudents ?? 100}
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Max staff
        <input
          type="number"
          name="maxStaff"
          min={0}
          step={1}
          required
          defaultValue={plan?.maxStaff ?? 10}
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Max courses
        <input
          type="number"
          name="maxCourses"
          min={0}
          step={1}
          required
          defaultValue={plan?.maxCourses ?? 10}
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Max storage (bytes)
        <input
          type="number"
          name="maxStorageBytes"
          min={0}
          step={1}
          required
          defaultValue={plan?.maxStorageBytes ?? 1073741824}
          style={{ display: "block", width: "100%" }}
        />
      </label>

      <label>
        Reports level
        <select
          name="reportsLevel"
          defaultValue={plan?.reportsLevel ?? "basic"}
          style={{ display: "block", width: "100%" }}
        >
          {REPORTS_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>

      <label>
        <input
          type="checkbox"
          name="smsEnabled"
          defaultChecked={plan?.smsEnabled ?? false}
        />{" "}
        SMS enabled
      </label>
      <label>
        <input
          type="checkbox"
          name="emailEnabled"
          defaultChecked={plan?.emailEnabled ?? true}
        />{" "}
        Email enabled
      </label>
      <label>
        <input
          type="checkbox"
          name="certificateEnabled"
          defaultChecked={plan?.certificateEnabled ?? false}
        />{" "}
        Certificates enabled
      </label>

      {state.error && (
        <p role="alert" style={{ color: "crimson" }}>
          {state.error.message}
        </p>
      )}
      {state.ok && <p style={{ color: "green" }}>Saved.</p>}

      <button type="submit" disabled={pending}>
        {pending ? "Saving..." : mode === "create" ? "Create plan" : "Save changes"}
      </button>
    </form>
  );
}
