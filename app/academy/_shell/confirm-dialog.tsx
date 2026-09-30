"use client";

import { useState, useTransition, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "./ui";
import { showSuccessToast } from "@/lib/ui/toast";

type Variant = "primary" | "secondary" | "danger" | "dangerSolid";

export interface ConfirmActionResult {
  ok: boolean;
  error?: { message: string };
}

interface ConfirmButtonProps {
  /** Trigger button's visible label, e.g. "Delete", "Archive", "Remove access". */
  label: string;
  /** Modal heading — include the entity's name where practical, e.g. `Delete "Frontend Development"?`. */
  title: string;
  /** Modal body copy — say what happens and whether it can be undone. */
  description: ReactNode;
  /** Trigger + confirm button variant. Defaults to "danger" since this component exists for destructive actions. */
  variant?: Variant;
  /** Confirm button's own label inside the dialog; defaults to `label`. */
  confirmLabel?: string;
  className?: string;
  disabled?: boolean;
  onConfirm: () => Promise<ConfirmActionResult>;
  /** Called after a successful confirm (e.g. to clear local row-editing state). */
  onSuccess?: () => void;
  /** Toast shown after a successful confirm — defaults to `"${label} succeeded."`
   * (e.g. "Delete succeeded.", "Archive succeeded."). Pass `false` to suppress
   * the toast entirely for a caller that already gives its own feedback. */
  successMessage?: string | false;
  /**
   * For maximum-consequence actions (e.g. permanently deleting an academy):
   * the Confirm button stays disabled until the typed value exactly matches
   * `requiredValue` — a plain "are you sure" click is not enough.
   */
  confirmInput?: { label: string; requiredValue: string };
  /**
   * Controlled-mode escape hatch for embedding this dialog behind a
   * different trigger than this component's own button — e.g. a dropdown
   * menu item (see app/academy/staff/staff-table.tsx). Pass both together;
   * when present, the internal trigger `<Button>` is not rendered at all,
   * and `open`/`onOpenChange` fully own the dialog's visibility instead of
   * this component's own internal state. Omit both (the default) for the
   * original self-contained "this IS the trigger" usage — unaffected.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * The one reusable destructive-action confirmation dialog for the whole app,
 * built on shadcn/Radix `AlertDialog` (components/ui/alert-dialog.tsx) —
 * previously a hand-rolled `<div role="dialog">` with its own focus-trap/
 * Escape-key wiring; Radix now owns all of that (focus trap, Escape-to-
 * close, return-focus-to-trigger, `aria-modal`/`aria-labelledby`/
 * `aria-describedby` wiring) instead of this file reimplementing it. Every
 * external prop and calling convention is unchanged, so none of this
 * component's ~11 call sites across the app needed to change.
 *
 * One deliberate behavior difference from the old hand-rolled dialog:
 * clicking the overlay no longer dismisses it (Radix's `AlertDialog`
 * disables outside-dismiss by design, specifically for
 * confirmation/destructive dialogs — Escape and the Cancel button are the
 * only ways out). This is a safety improvement, not a regression: it
 * matches how every other production AlertDialog behaves, and prevents an
 * accidental stray click from silently dismissing a delete/archive
 * confirmation.
 */
export function ConfirmButton({
  label,
  title,
  description,
  variant = "danger",
  confirmLabel,
  className,
  disabled,
  onConfirm,
  onSuccess,
  successMessage,
  confirmInput,
  open: controlledOpen,
  onOpenChange,
}: ConfirmButtonProps) {
  const isControlled = controlledOpen !== undefined && onOpenChange !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [typedValue, setTypedValue] = useState("");

  // "Adjusting state when a prop changes" (react.dev's own documented
  // pattern for this) rather than a `useEffect` — resets these the instant
  // `open` flips to true, during render, with no extra commit/flicker.
  // The single reset path for both modes: Radix's own Trigger opens the
  // dialog without any custom onClick of ours to hook a reset into, so this
  // is not merely the controlled-mode path anymore — it's the only one.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setError(null);
      setTypedValue("");
    }
  }

  const inputSatisfied = !confirmInput || typedValue === confirmInput.requiredValue;

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await onConfirm();
      if (!result.ok) {
        setError(result.error?.message ?? "Something went wrong. Please try again.");
        return;
      }
      setOpen(false);
      setTypedValue("");
      if (successMessage !== false) {
        showSuccessToast(successMessage ?? `${label} succeeded.`);
      }
      onSuccess?.();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {!isControlled && (
        <AlertDialogTrigger asChild>
          <Button type="button" variant={variant} className={className} disabled={disabled}>
            {label}
          </Button>
        </AlertDialogTrigger>
      )}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {confirmInput && (
          <label className="mt-4 block">
            <span className="mb-1 block text-xs font-medium text-muted">{confirmInput.label}</span>
            <input
              type="text"
              value={typedValue}
              onChange={(event) => setTypedValue(event.target.value)}
              autoComplete="off"
              className="block w-full rounded-control border border-border-strong bg-surface px-3 py-2 text-sm text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
          </label>
        )}
        {error && (
          <p role="alert" className="mt-3 rounded-control border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button type="button" variant="ghost" disabled={isPending}>
              Cancel
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              type="button"
              variant={variant}
              disabled={isPending || !inputSatisfied}
              onClick={(event) => {
                // AlertDialogAction does not auto-close (unlike Cancel) —
                // but this preventDefault makes that explicit rather than
                // relying on it, since `handleConfirm` decides whether to
                // close (only on success, keeping the dialog open with the
                // error message shown on failure).
                event.preventDefault();
                handleConfirm();
              }}
            >
              {isPending ? "Working..." : (confirmLabel ?? label)}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface EligibilityGatedDeleteButtonProps {
  /** e.g. "Student", "Course" — used only for the disabled-state tooltip's
   * wording ("this student cannot be permanently deleted because ..."). */
  entityLabel: string;
  /** The record's exact current display name — used both as the dialog's
   * type-to-confirm required value and in its title. */
  entityName: string;
  eligible: boolean;
  /** Plain-English reasons blocking deletion, already computed server-side
   * (never re-derived here) — e.g. "3 batch enrollments", "1 payment". */
  reasons: string[];
  onConfirm: () => Promise<ConfirmActionResult>;
  onSuccess?: () => void;
  className?: string;
}

/**
 * The shared "real conditional Delete" control for Students/Staff/
 * Programs/Courses/Batches — same visual language across all five so a
 * viewer only has to learn this once. Eligibility is entirely server-
 * computed (each entity's own listX function) and handed in as plain
 * props; this component never re-derives or second-guesses it — it only
 * decides which of the two states to render, exactly the same split
 * app/platform/academies/[id]/delete-academy-section.tsx already
 * established for academy deletion. `dangerSolid` (solid fill) throughout
 * so Delete is never visually confusable with the outlined `danger`
 * Archive button next to it.
 */
export function EligibilityGatedDeleteButton({
  entityLabel,
  entityName,
  eligible,
  reasons,
  onConfirm,
  onSuccess,
  className,
}: EligibilityGatedDeleteButtonProps) {
  if (!eligible) {
    return (
      <span
        title={`This ${entityLabel.toLowerCase()} cannot be permanently deleted because ${reasons.join("; ")}. Use Archive instead.`}
      >
        <Button type="button" variant="dangerSolid" className={`px-2.5 py-1 text-xs ${className ?? ""}`} disabled>
          Delete
        </Button>
      </span>
    );
  }

  return (
    <ConfirmButton
      label="Delete"
      variant="dangerSolid"
      className={`px-2.5 py-1 text-xs ${className ?? ""}`}
      title={`Delete "${entityName}" permanently?`}
      description={<>This cannot be undone.</>}
      confirmInput={{ label: `Type "${entityName}" to confirm`, requiredValue: entityName }}
      onConfirm={onConfirm}
      onSuccess={onSuccess}
    />
  );
}
