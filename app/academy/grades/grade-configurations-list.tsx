"use client";

import { startTransition, useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  activateGradeConfigurationAction,
  approveGradeConfigAction,
  copyGradeConfigAction,
  createGradeConfiguration,
  rejectGradeConfigAction,
  submitGradeConfigForApprovalAction,
  updateGradeBands,
  type GradeConfigFormState,
  type GradeConfigLifecycleActionResult,
} from "@/lib/academies/grade-configurations-actions";
import type { GradeBandRecord, GradeConfigurationRecord } from "@/lib/academies/grade-configurations";
import { NETWORK_ERROR_MESSAGE, guardAction } from "@/lib/ui/guard-action";
import { formatDate } from "@/lib/ui/date";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Badge, Button, EmptyState, PageHeader, Section, humanizeStatus, trHover } from "@/app/academy/_shell/ui";
import { DataTable, NoteBlock, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { Icon } from "@/app/academy/_shell/icons";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  controlClass,
  fieldControlArea,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";

/**
 * Grades (design A11): grade configurations, one active at a time. Each row
 * shows its bands, who created it and its status, with the actions its
 * status allows: Edit bands and Submit for approval on a draft; Approve or
 * Reject a pending one (never your own submission); Make active once
 * approved; Copy as draft to revise anything that is no longer a draft.
 * Every action is the existing server action with its own permission and
 * state checks.
 */

type Config = GradeConfigurationRecord & { bands: GradeBandRecord[] };

const STATUS_TONE: Record<Config["status"], "gray" | "amber" | "blue" | "green" | "slate"> = {
  draft: "gray",
  pending_approval: "amber",
  approved: "blue",
  active: "green",
  retired: "slate",
};

const ROW_BTN =
  "inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:cursor-not-allowed disabled:opacity-50";
const ROW_BTN_PRIMARY =
  "inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded-lg bg-brand px-3.5 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50";

function bandTag(band: GradeBandRecord) {
  return `${band.label} ${band.minMark}-${band.maxMark}${band.isPass ? "" : " fail"}`;
}

export function GradeConfigurationsList({
  configurations,
  creatorNames,
  canManage,
  canApprove,
}: {
  configurations: Config[];
  creatorNames: Record<string, string>;
  canManage: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [pending, startPending] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [bandsFor, setBandsFor] = useState<Config | null>(null);
  const [rejectFor, setRejectFor] = useState<Config | null>(null);
  const [activateFor, setActivateFor] = useState<Config | null>(null);

  function run(action: () => Promise<GradeConfigLifecycleActionResult>, success: string) {
    startPending(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          showErrorToast(result.error.message);
          return;
        }
        showSuccessToast(success);
        router.refresh();
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  const sorted = [...configurations].sort(
    (a, b) => Number(b.status === "active") - Number(a.status === "active") || b.createdAt.getTime() - a.createdAt.getTime(),
  );

  return (
    <section className="flex flex-col">
      <PageHeader
        title="Grades"
        description="Grade configurations. One is active at a time. Edit bands while a configuration is a draft; to change an approved or active one, copy it as a draft."
        actions={
          canManage ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              New configuration
            </Button>
          ) : undefined
        }
      />

      {sorted.length === 0 ? (
        <Section>
          <EmptyState message="No grade configurations yet." icon={<Icon name="sliders" />} />
        </Section>
      ) : (
        <DataTable stackBelow={1040}>
          <thead>
            <tr>
              <th className={rtTh}>Configuration</th>
              <th className={rtTh}>Bands</th>
              <th className={rtTh}>Created by</th>
              <th className={rtTh}>Status</th>
              <th className={rtTh}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((config) => {
              return (
                <tr key={config.id} className={trHover}>
                  <td className={`${rtTd} font-semibold`} data-label="Configuration">
                    {config.name}
                  </td>
                  <td className={rtTd} data-label="Bands">
                    {config.bands.length === 0 ? (
                      <span className="text-muted">No bands yet</span>
                    ) : (
                      <span className="flex flex-wrap gap-1.5">
                        {config.bands.map((band) => (
                          <span
                            key={band.id}
                            className="inline-flex items-center rounded-full bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand"
                          >
                            {bandTag(band)}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className={rtTd} data-label="Created by">
                    {creatorNames[config.createdBy] ?? "Staff member"}
                  </td>
                  <td className={rtTd} data-label="Status">
                    <span className="inline-flex flex-col items-start gap-1">
                      <Badge label={humanizeStatus(config.status)} tone={STATUS_TONE[config.status]} />
                      {config.approvedBy && config.approvedAt && (
                        <span className="text-xs text-muted">
                          Approved by {creatorNames[config.approvedBy] ?? "a staff member"} on {formatDate(config.approvedAt)}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className={rtTd} data-actions="">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {config.status === "draft" && canManage && (
                        <>
                          <button type="button" className={ROW_BTN} onClick={() => setBandsFor(config)}>
                            <Icon name="sliders" width={16} height={16} />
                            Edit bands
                          </button>
                          <button
                            type="button"
                            className={ROW_BTN_PRIMARY}
                            disabled={pending || config.bands.length === 0}
                            title={config.bands.length === 0 ? "Add bands before submitting." : undefined}
                            onClick={() => run(() => submitGradeConfigForApprovalAction(config.id), "Submitted for approval.")}
                          >
                            <Icon name="upload" width={16} height={16} />
                            Submit for approval
                          </button>
                        </>
                      )}
                      {config.status === "pending_approval" && canApprove && (
                        <>
                          <button
                            type="button"
                            className={ROW_BTN_PRIMARY}
                            disabled={pending}
                            onClick={() => run(() => approveGradeConfigAction(config.id), "Configuration approved. Make it active when you're ready.")}
                          >
                            <Icon name="check_circle" width={16} height={16} />
                            Approve
                          </button>
                          <button
                            type="button"
                            className={ROW_BTN}
                            disabled={pending}
                            onClick={() => setRejectFor(config)}
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {config.status === "approved" && canManage && (
                        <button type="button" className={ROW_BTN_PRIMARY} disabled={pending} onClick={() => setActivateFor(config)}>
                          <Icon name="check_circle" width={16} height={16} />
                          Make active
                        </button>
                      )}
                      {config.status !== "draft" && canManage && (
                        <button
                          type="button"
                          className={ROW_BTN}
                          disabled={pending}
                          onClick={() => run(() => copyGradeConfigAction(config.id), "Draft copy created. Edit its bands, then submit it.")}
                        >
                          <Icon name="layers" width={16} height={16} />
                          Copy as draft
                        </button>
                      )}
                      {!canManage && !canApprove && <span className="text-muted">View only</span>}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      <NoteBlock>
        Bands cannot overlap; the database enforces this. A draft is submitted for approval; an approver other than the person
        who submitted it approves it, and it then becomes the active configuration when made active. Published results keep
        the configuration they were published under.
      </NoteBlock>

      {canManage && (
        <DesignDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          title="New grade configuration"
          description="It starts as a draft with no bands. Add its bands, then submit it for approval."
        >
          {createOpen && <CreateFields onCancel={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); router.refresh(); }} />}
        </DesignDialog>
      )}
      {bandsFor && (
        <DesignDialog
          open
          onOpenChange={(open) => !open && setBandsFor(null)}
          title={`Edit grade bands, ${bandsFor.name}`}
          description="Allowed only while the configuration is a draft. Bands must not overlap. Usually they run from 0 to 100 with no gaps."
          width={640}
        >
          <BandsFields config={bandsFor} onCancel={() => setBandsFor(null)} onSaved={() => { setBandsFor(null); router.refresh(); }} />
        </DesignDialog>
      )}
      {rejectFor && (
        <DesignDialog
          open
          onOpenChange={(open) => !open && setRejectFor(null)}
          title={`Reject ${rejectFor.name}`}
          description="It goes back to draft so its bands can be fixed and submitted again."
        >
          <RejectFields config={rejectFor} onCancel={() => setRejectFor(null)} onDone={() => { setRejectFor(null); router.refresh(); }} />
        </DesignDialog>
      )}
      {activateFor && (
        <ConfirmButton
          label="Activate"
          variant="primary"
          icon="check_circle"
          open
          onOpenChange={(open) => !open && setActivateFor(null)}
          title={`Activate ${activateFor.name}?`}
          description={<>This becomes the active configuration and the current one is retired. Published results keep the configuration they were published under.</>}
          successMessage="Configuration activated."
          onConfirm={() => activateGradeConfigurationAction(activateFor.id)}
          onSuccess={() => router.refresh()}
        />
      )}
    </section>
  );
}

const guardedCreate = guardAction(createGradeConfiguration);
const guardedUpdateBands = guardAction(updateGradeBands);
const initialState: GradeConfigFormState = { ok: false };
const CREATE_RULES: DesignFormRule[] = [{ name: "name", label: "Name", required: true }];

function CreateFields({ onCancel, onSaved }: { onCancel: () => void; onSaved: () => void }) {
  const [state, formAction, pending] = useActionState(guardedCreate, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(CREATE_RULES);
  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Draft configuration created.");
      onSaved();
    } else if (state.error) showServerError(state.error.message, [[/name/i, "name"]]);
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form ref={formRef} noValidate className="flex min-h-0 flex-1 flex-col" onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}>
      <DialogBody>
        <FieldGrid>
          <DField label="Name" name="name" required error={errors.name} full>
            <input
              type="text"
              name="name"
              maxLength={200}
              placeholder="Standard Grading 2027"
              onBlur={blur("name")}
              className={controlClass(Boolean(errors.name))}
              {...invalidProps("name", errors.name)}
            />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Create draft" pendingLabel="Creating…" pending={pending} />
    </form>
  );
}

interface BandDraft {
  label: string;
  minMark: string;
  maxMark: string;
  isPass: boolean;
}

function BandsFields({ config, onCancel, onSaved }: { config: Config; onCancel: () => void; onSaved: () => void }) {
  const [state, formAction, pending] = useActionState(guardedUpdateBands, initialState);
  const [bands, setBands] = useState<BandDraft[]>(() =>
    config.bands.length > 0
      ? config.bands.map((b) => ({ label: b.label, minMark: String(b.minMark), maxMark: String(b.maxMark), isPass: b.isPass }))
      : [
          { label: "A", minMark: "90", maxMark: "100", isPass: true },
          { label: "B", minMark: "70", maxMark: "89", isPass: true },
          { label: "C", minMark: "50", maxMark: "69", isPass: true },
          { label: "F", minMark: "0", maxMark: "49", isPass: false },
        ],
  );
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Bands saved.");
      onSaved();
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  function update(index: number, patch: Partial<BandDraft>) {
    setBands((current) => current.map((band, i) => (i === index ? { ...band, ...patch } : band)));
  }

  function validateBands(): boolean {
    const next: Record<number, string> = {};
    bands.forEach((band, i) => {
      const min = Number(band.minMark);
      const max = Number(band.maxMark);
      if (!band.label.trim()) next[i] = "Give the grade a name.";
      else if (band.minMark.trim() === "" || band.maxMark.trim() === "" || !Number.isFinite(min) || !Number.isFinite(max)) next[i] = "Enter both ends of the range.";
      else if (max < min) next[i] = "The upper mark must be at least the lower mark.";
    });
    if (Object.keys(next).length === 0) {
      for (let i = 0; i < bands.length; i += 1) {
        for (let j = i + 1; j < bands.length; j += 1) {
          const a = bands[i];
          const b = bands[j];
          if (Number(a.minMark) <= Number(b.maxMark) && Number(b.minMark) <= Number(a.maxMark)) next[j] = `Overlaps grade ${a.label || i + 1}.`;
        }
      }
    }
    setRowErrors(next);
    const count = Object.keys(next).length;
    setBanner(bands.length === 0 ? "Add at least one grade." : count > 1 ? `${count} grades need attention. They are marked below.` : null);
    return count === 0 && bands.length > 0;
  }

  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!validateBands()) return;
        const data = new FormData();
        data.set("gradeConfigurationId", config.id);
        data.set(
          "bandsJson",
          JSON.stringify(bands.map((b) => ({ label: b.label.trim(), minMark: b.minMark, maxMark: b.maxMark, isPass: b.isPass }))),
        );
        startTransition(() => formAction(data));
      }}
    >
      <DialogBody>
        <div className="mb-2 hidden grid-cols-[minmax(0,1fr)_88px_88px_150px_44px] gap-3 text-[13px] font-semibold text-ink sm:grid">
          <span>Grade</span>
          <span>From</span>
          <span>To</span>
          <span>Counts as</span>
          <span className="sr-only">Remove</span>
        </div>
        <div className="flex flex-col gap-3">
          {bands.map((band, index) => (
            <div key={index} className="flex flex-col gap-1">
              <div className="grid grid-cols-[minmax(0,1fr)_88px_88px] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_88px_88px_150px_44px]">
                <input
                  aria-label={`Grade ${index + 1} name`}
                  value={band.label}
                  maxLength={100}
                  placeholder="A"
                  onChange={(event) => update(index, { label: event.target.value })}
                  className={controlClass(Boolean(rowErrors[index]))}
                />
                <input
                  aria-label={`Grade ${index + 1} lowest mark`}
                  inputMode="decimal"
                  value={band.minMark}
                  onChange={(event) => update(index, { minMark: event.target.value })}
                  className={`${controlClass(Boolean(rowErrors[index]))} text-center tabular-nums`}
                />
                <input
                  aria-label={`Grade ${index + 1} highest mark`}
                  inputMode="decimal"
                  value={band.maxMark}
                  onChange={(event) => update(index, { maxMark: event.target.value })}
                  className={`${controlClass(Boolean(rowErrors[index]))} text-center tabular-nums`}
                />
                <span role="radiogroup" aria-label={`Grade ${index + 1} counts as`} className="col-span-2 grid grid-cols-2 gap-1.5 sm:col-span-1">
                  {[true, false].map((pass) => (
                    <button
                      key={String(pass)}
                      type="button"
                      role="radio"
                      aria-checked={band.isPass === pass}
                      onClick={() => update(index, { isPass: pass })}
                      className={`h-11 rounded-lg border text-[13px] font-semibold transition-colors duration-150 ${
                        band.isPass === pass ? "border-brand bg-brand text-white" : "border-border-strong bg-surface text-ink hover:bg-app"
                      }`}
                    >
                      {pass ? "Pass" : "Fail"}
                    </button>
                  ))}
                </span>
                <button
                  type="button"
                  aria-label={`Remove grade ${band.label || index + 1}`}
                  onClick={() => setBands((current) => current.filter((_, i) => i !== index))}
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-muted hover:bg-app hover:text-[#B91C1C]"
                >
                  <Icon name="close" width={18} height={18} />
                </button>
              </div>
              {rowErrors[index] && (
                <span role="alert" className="text-xs font-medium text-[#B91C1C]">
                  {rowErrors[index]}
                </span>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setBands((current) => [...current, { label: "", minMark: "", maxMark: "", isPass: true }])}
          className="mt-3 inline-flex h-10 items-center rounded-lg border border-dashed border-border-strong px-3.5 text-[13px] font-semibold text-ink hover:bg-app"
        >
          Add a grade
        </button>
        <FormErrorBanner message={banner ?? state.error?.message ?? null} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Save bands" pendingLabel="Saving…" pending={pending} />
    </form>
  );
}

function RejectFields({ config, onCancel, onDone }: { config: Config; onCancel: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason.trim()) {
          setError("Give a reason so the author knows what to fix.");
          return;
        }
        setError(null);
        start(async () => {
          try {
            const result = await rejectGradeConfigAction(config.id, reason.trim());
            if (!result.ok) {
              setBanner(result.error.message);
              return;
            }
            showSuccessToast("Configuration rejected.");
            onDone();
          } catch {
            setBanner(NETWORK_ERROR_MESSAGE);
          }
        });
      }}
    >
      <DialogBody>
        <DField label="Reason" name="reason" required error={error ?? undefined} full>
          <textarea
            name="reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={`${fieldControlArea} ${error ? "border-[#B91C1C]" : "border-border-strong"} min-h-[88px]`}
            {...invalidProps("reason", error ?? undefined)}
          />
        </DField>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Reject" pendingLabel="Rejecting…" pending={pending} danger />
    </form>
  );
}
