"use client";

import { useActionState, useState, useTransition } from "react";
import {
  approveGradeConfigAction,
  activateGradeConfigurationAction,
  createGradeConfiguration,
  rejectGradeConfigAction,
  submitGradeConfigForApprovalAction,
  updateGradeBands,
  type GradeConfigFormState,
  type GradeConfigLifecycleActionResult,
} from "@/lib/academies/grade-configurations-actions";
import type { GradeConfigurationRecord } from "@/lib/academies/grade-configurations";

const initialFormState: GradeConfigFormState = { ok: false };

interface ListProps {
  configurations: GradeConfigurationRecord[];
  canManage: boolean;
  canApprove: boolean;
  currentUserId: string;
}

/**
 * PLAN.md Item 47 — `/academy/grades`'s client half. Same
 * useActionState-driven table+form shape as app/academy/batches/
 * batches-list.tsx for create; the four lifecycle transitions
 * (submit/approve/reject/activate) are single confirm-and-fire buttons
 * called directly (useTransition), matching lib/academies/
 * lifecycle-actions.ts's direct-call convention rather than a form.
 *
 * DESIGN.md §11.4: a submitter's own pending submission shows Approve
 * (and Reject, same approval-authority scoping per PLAN.md's lifecycle
 * table) disabled with a tooltip, never hidden — see `isOwnSubmission`
 * below, compared against `GradeConfigurationRecord.submittedBy`
 * (the requestedBy of the config's approval_requests row).
 */
export function GradeConfigurationsList({
  configurations,
  canManage,
  canApprove,
  currentUserId,
}: ListProps) {
  const [createState, createFormAction, creating] = useActionState(
    createGradeConfiguration,
    initialFormState,
  );

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th style={{ padding: "0.5rem" }}>Name</th>
            <th style={{ padding: "0.5rem" }}>Status</th>
            <th style={{ padding: "0.5rem" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {configurations.length === 0 ? (
            <tr>
              <td colSpan={3} style={{ padding: "0.5rem", color: "#666" }}>
                No grade configurations yet.
              </td>
            </tr>
          ) : (
            configurations.map((config) => (
              <GradeConfigRow
                key={config.id}
                config={config}
                canManage={canManage}
                canApprove={canApprove}
                currentUserId={currentUserId}
              />
            ))
          )}
        </tbody>
      </table>

      {canManage && (
        <>
          <h2 style={{ marginTop: "2rem" }}>Add grade configuration</h2>
          <form
            action={createFormAction}
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
          >
            <label>
              Name
              <input type="text" name="name" required style={{ display: "block", width: "100%" }} />
            </label>
            {createState.error && (
              <p role="alert" style={{ color: "crimson" }}>
                {createState.error.message}
              </p>
            )}
            {createState.ok && <p style={{ color: "green" }}>Configuration created as Draft.</p>}
            <button type="submit" disabled={creating}>
              {creating ? "Creating..." : "Create configuration"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}

interface BandDraft {
  label: string;
  minMark: string;
  maxMark: string;
  isPass: boolean;
}

const EMPTY_BAND: BandDraft = { label: "", minMark: "", maxMark: "", isPass: true };

interface RowProps {
  config: GradeConfigurationRecord;
  canManage: boolean;
  canApprove: boolean;
  currentUserId: string;
}

function GradeConfigRow({ config, canManage, canApprove, currentUserId }: RowProps) {
  const [pending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const [showBandsEditor, setShowBandsEditor] = useState(false);
  const [showRejectReason, setShowRejectReason] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [bands, setBands] = useState<BandDraft[]>([{ ...EMPTY_BAND }]);
  const [bandsFormState, bandsFormAction, savingBands] = useActionState(
    updateGradeBands,
    initialFormState,
  );

  // "You can't approve a transaction you recorded." (DESIGN.md §11.7's
  // copy library — reused verbatim here for the grade-config queue, same
  // rule per §11.4).
  const isOwnSubmission = config.submittedBy === currentUserId;

  function updateBand(index: number, patch: Partial<BandDraft>): void {
    setBands((prev) => prev.map((band, i) => (i === index ? { ...band, ...patch } : band)));
  }

  function addBand(): void {
    setBands((prev) => [...prev, { ...EMPTY_BAND }]);
  }

  function removeBand(index: number): void {
    setBands((prev) => prev.filter((_, i) => i !== index));
  }

  function runLifecycleAction(action: () => Promise<GradeConfigLifecycleActionResult>): void {
    setActionError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setActionError(result.error.message);
        return;
      }
      if (showRejectReason) {
        setShowRejectReason(false);
        setRejectReason("");
      }
    });
  }

  return (
    <>
      <tr style={{ borderBottom: "1px solid #eee" }}>
        <td style={{ padding: "0.5rem" }}>{config.name}</td>
        <td style={{ padding: "0.5rem" }}>{config.status}</td>
        <td style={{ padding: "0.5rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
            {config.status === "draft" && canManage && (
              <>
                <button type="button" onClick={() => setShowBandsEditor((value) => !value)}>
                  {showBandsEditor ? "Hide bands" : "Edit bands"}
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => runLifecycleAction(() => submitGradeConfigForApprovalAction(config.id))}
                >
                  Submit for approval
                </button>
              </>
            )}

            {config.status === "pending_approval" && (
              <>
                <button
                  type="button"
                  disabled={pending || !canApprove || isOwnSubmission}
                  title={
                    isOwnSubmission ? "You can't approve a transaction you recorded." : undefined
                  }
                  onClick={() => runLifecycleAction(() => approveGradeConfigAction(config.id))}
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={pending || !canApprove || isOwnSubmission}
                  title={
                    isOwnSubmission ? "You can't approve a transaction you recorded." : undefined
                  }
                  onClick={() => setShowRejectReason((value) => !value)}
                >
                  Reject
                </button>
              </>
            )}

            {config.status === "approved" && canManage && (
              <button
                type="button"
                disabled={pending}
                onClick={() => runLifecycleAction(() => activateGradeConfigurationAction(config.id))}
              >
                Activate
              </button>
            )}

            {config.status === "active" && (
              <span style={{ color: "#666", fontSize: "0.85rem" }}>
                Active — no in-place edit; create a new configuration to revise it.
              </span>
            )}

            {config.status === "retired" && <span style={{ color: "#999" }}>Retired</span>}
          </div>
        </td>
      </tr>

      {actionError && (
        <tr>
          <td colSpan={3} style={{ padding: "0 0.5rem 0.5rem", color: "crimson" }}>
            {actionError}
          </td>
        </tr>
      )}

      {showRejectReason && config.status === "pending_approval" && (
        <tr>
          <td colSpan={3} style={{ padding: "0.5rem", background: "#fafafa" }}>
            <label>
              Rejection reason (required)
              <input
                type="text"
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                style={{ display: "block", width: "100%" }}
              />
            </label>
            <button
              type="button"
              disabled={pending || rejectReason.trim().length === 0}
              onClick={() =>
                runLifecycleAction(() => rejectGradeConfigAction(config.id, rejectReason))
              }
              style={{ marginTop: "0.5rem" }}
            >
              Confirm reject
            </button>
          </td>
        </tr>
      )}

      {showBandsEditor && config.status === "draft" && (
        <tr>
          <td colSpan={3} style={{ padding: "0.5rem", background: "#fafafa" }}>
            <form action={bandsFormAction}>
              <input type="hidden" name="gradeConfigurationId" value={config.id} />
              <input
                type="hidden"
                name="bandsJson"
                value={JSON.stringify(
                  bands.map((band) => ({
                    label: band.label,
                    minMark: band.minMark,
                    maxMark: band.maxMark,
                    isPass: band.isPass,
                  })),
                )}
              />
              {bands.map((band, index) => (
                <div
                  key={index}
                  style={{ display: "flex", gap: "0.5rem", marginBottom: "0.25rem", alignItems: "center" }}
                >
                  <input
                    placeholder="Label"
                    value={band.label}
                    onChange={(event) => updateBand(index, { label: event.target.value })}
                  />
                  <input
                    placeholder="Min"
                    value={band.minMark}
                    onChange={(event) => updateBand(index, { minMark: event.target.value })}
                    style={{ width: 80 }}
                  />
                  <input
                    placeholder="Max"
                    value={band.maxMark}
                    onChange={(event) => updateBand(index, { maxMark: event.target.value })}
                    style={{ width: 80 }}
                  />
                  <label style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                    <input
                      type="checkbox"
                      checked={band.isPass}
                      onChange={(event) => updateBand(index, { isPass: event.target.checked })}
                    />
                    Pass
                  </label>
                  <button type="button" onClick={() => removeBand(index)}>
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" onClick={addBand}>
                Add band
              </button>
              {bandsFormState.error && (
                <p role="alert" style={{ color: "crimson" }}>
                  {bandsFormState.error.message}
                </p>
              )}
              {bandsFormState.ok && <p style={{ color: "green" }}>Bands saved.</p>}
              <div>
                <button type="submit" disabled={savingBands}>
                  {savingBands ? "Saving..." : "Save bands"}
                </button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
