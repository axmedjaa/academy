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
import { Badge, Button, ErrorMessage, Field, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";

const initialFormState: GradeConfigFormState = { ok: false };

interface ListProps {
  configurations: GradeConfigurationRecord[];
  canManage: boolean;
  canApprove: boolean;
  currentUserId: string;
}

function statusTone(status: string): "green" | "amber" | "gray" | "blue" {
  if (status === "active") return "green";
  if (status === "pending_approval") return "amber";
  if (status === "approved") return "blue";
  return "gray";
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
    <section className="flex flex-col gap-6">
      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Name</th>
            <th className={th}>Status</th>
            <th className={th}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {configurations.length === 0 ? (
            <tr>
              <td colSpan={3} className={`${td} text-center text-muted`}>
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
      </TableWrap>

      {canManage && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Add grade configuration</h2>
          <form action={createFormAction} className="mt-4 flex max-w-md flex-col gap-3">
            <Field label="Name">
              <input type="text" name="name" required className={inputClass} />
            </Field>
            {createState.error && <ErrorMessage message={createState.error.message} />}
            {createState.ok && <p className="text-sm font-medium text-success">Configuration created as Draft.</p>}
            <Button type="submit" disabled={creating} className="self-start">
              {creating ? "Creating..." : "Create configuration"}
            </Button>
          </form>
        </Section>
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
      <tr className={trHover}>
        <td className={`${td} font-medium`}>{config.name}</td>
        <td className={td}>
          <Badge label={config.status} tone={statusTone(config.status)} />
        </td>
        <td className={td}>
          <div className="flex flex-wrap items-center gap-2">
            {config.status === "draft" && canManage && (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  className="px-2.5 py-1 text-xs"
                  onClick={() => setShowBandsEditor((value) => !value)}
                >
                  {showBandsEditor ? "Hide bands" : "Edit bands"}
                </Button>
                <Button
                  type="button"
                  className="px-2.5 py-1 text-xs"
                  disabled={pending}
                  onClick={() => runLifecycleAction(() => submitGradeConfigForApprovalAction(config.id))}
                >
                  Submit for approval
                </Button>
              </>
            )}

            {config.status === "pending_approval" && (
              <>
                <Button
                  type="button"
                  className="px-2.5 py-1 text-xs"
                  disabled={pending || !canApprove || isOwnSubmission}
                  title={isOwnSubmission ? "You can't approve a transaction you recorded." : undefined}
                  onClick={() => runLifecycleAction(() => approveGradeConfigAction(config.id))}
                >
                  Approve
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  className="px-2.5 py-1 text-xs"
                  disabled={pending || !canApprove || isOwnSubmission}
                  title={isOwnSubmission ? "You can't approve a transaction you recorded." : undefined}
                  onClick={() => setShowRejectReason((value) => !value)}
                >
                  Reject
                </Button>
              </>
            )}

            {config.status === "approved" && canManage && (
              <Button
                type="button"
                className="px-2.5 py-1 text-xs"
                disabled={pending}
                onClick={() => runLifecycleAction(() => activateGradeConfigurationAction(config.id))}
              >
                Activate
              </Button>
            )}

            {config.status === "active" && (
              <span className="text-sm text-muted">
                Active — no in-place edit; create a new configuration to revise it.
              </span>
            )}

            {config.status === "retired" && <span className="text-sm text-muted">Retired</span>}
          </div>
        </td>
      </tr>

      {actionError && (
        <tr>
          <td colSpan={3} className="px-4 pb-3">
            <ErrorMessage message={actionError} />
          </td>
        </tr>
      )}

      {showRejectReason && config.status === "pending_approval" && (
        <tr>
          <td colSpan={3} className="bg-app px-4 py-3">
            <Field label="Rejection reason (required)" className="max-w-sm">
              <input
                type="text"
                value={rejectReason}
                onChange={(event) => setRejectReason(event.target.value)}
                className={inputClass}
              />
            </Field>
            <Button
              type="button"
              variant="danger"
              className="mt-2"
              disabled={pending || rejectReason.trim().length === 0}
              onClick={() => runLifecycleAction(() => rejectGradeConfigAction(config.id, rejectReason))}
            >
              Confirm reject
            </Button>
          </td>
        </tr>
      )}

      {showBandsEditor && config.status === "draft" && (
        <tr>
          <td colSpan={3} className="bg-app px-4 py-3">
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
              <div className="flex flex-col gap-2">
                {bands.map((band, index) => (
                  <div key={index} className="flex flex-wrap items-center gap-2">
                    <input
                      placeholder="Label"
                      value={band.label}
                      onChange={(event) => updateBand(index, { label: event.target.value })}
                      className={`${inputClass} w-36 py-1.5`}
                    />
                    <input
                      placeholder="Min"
                      value={band.minMark}
                      onChange={(event) => updateBand(index, { minMark: event.target.value })}
                      className={`${inputClass} w-20 py-1.5`}
                    />
                    <input
                      placeholder="Max"
                      value={band.maxMark}
                      onChange={(event) => updateBand(index, { maxMark: event.target.value })}
                      className={`${inputClass} w-20 py-1.5`}
                    />
                    <label className="flex items-center gap-1.5 text-sm text-ink">
                      <input
                        type="checkbox"
                        checked={band.isPass}
                        onChange={(event) => updateBand(index, { isPass: event.target.checked })}
                        className="h-4 w-4 rounded border-border-strong text-brand focus:ring-brand/30"
                      />
                      Pass
                    </label>
                    <Button type="button" variant="danger" className="px-2.5 py-1 text-xs" onClick={() => removeBand(index)}>
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
              <Button type="button" variant="secondary" className="mt-2" onClick={addBand}>
                Add band
              </Button>
              {bandsFormState.error && (
                <div className="mt-2">
                  <ErrorMessage message={bandsFormState.error.message} />
                </div>
              )}
              {bandsFormState.ok && <p className="mt-2 text-sm font-medium text-success">Bands saved.</p>}
              <div className="mt-3">
                <Button type="submit" disabled={savingBands}>
                  {savingBands ? "Saving..." : "Save bands"}
                </Button>
              </div>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
