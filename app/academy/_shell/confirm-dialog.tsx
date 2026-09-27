"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
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

/** Every `a[href]`/button/input/etc. inside `container` that can currently
 * receive focus — the Tab-trap below cycles within exactly this list rather
 * than letting focus escape to the page underneath the dialog. */
function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

/**
 * The one reusable destructive-action confirmation dialog for the whole app
 * — no reusable dialog/modal existed before this (the only prior
 * "confirmation" anywhere was a raw `window.confirm()` in
 * app/platform/subscriptions/subscriptions-manager.tsx, which this does not
 * touch or replace, per this task's own scope). Every new delete/archive/
 * remove action added by this pass uses this component instead of
 * `window.confirm()`, styled with the same tokens as the rest of the
 * Tailwind pass (Button, brand/danger colors, card surface).
 *
 * Phase 4 (frontend redesign) accessibility pass: on open, focus moves into
 * the dialog and Tab cycles only among its own focusable elements (a
 * standard modal focus trap — previously absent, meaning Tab could escape
 * to the page behind the overlay); on close, focus returns to whichever
 * button opened it, captured from the click event itself rather than a
 * forwarded ref (sidesteps any question of whether the `Button` wrapper
 * forwards refs — it doesn't need to for this).
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerElRef = useRef<HTMLButtonElement | null>(null);

  // "Adjusting state when a prop changes" (react.dev's own documented
  // pattern for this) rather than a `useEffect` — resets these the instant
  // `open` flips to true, during render, with no extra commit/flicker.
  // Needed for controlled mode, which has no trigger `onClick` here to do
  // this reset itself; harmless (merely redundant) for the uncontrolled
  // path, where the trigger's own `onClick` already does the same reset.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setError(null);
      setTypedValue("");
    }
  }

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerElRef.current?.focus();
        return;
      }
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = getFocusableElements(dialogRef.current);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);

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
      triggerElRef.current?.focus();
      if (successMessage !== false) {
        showSuccessToast(successMessage ?? `${label} succeeded.`);
      }
      onSuccess?.();
    });
  }

  return (
    <>
      {!isControlled && (
        <Button
          type="button"
          variant={variant}
          className={className}
          disabled={disabled}
          onClick={(event) => {
            triggerElRef.current = event.currentTarget;
            setError(null);
            setTypedValue("");
            setOpen(true);
          }}
        >
          {label}
        </Button>
      )}
      {open && (
        <div
          role="presentation"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-navy/40 p-4 motion-safe:animate-fade-in"
          onClick={() => {
            if (isPending) return;
            setOpen(false);
            triggerElRef.current?.focus();
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-description"
            tabIndex={-1}
            className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-card border border-border bg-surface p-5 shadow-card outline-none motion-safe:animate-scale-in"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="confirm-dialog-title" className="text-base font-semibold text-ink">
              {title}
            </h2>
            <div id="confirm-dialog-description" className="mt-2 text-sm text-muted">
              {description}
            </div>
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
            <div className="mt-5 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  triggerElRef.current?.focus();
                }}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button type="button" variant={variant} onClick={handleConfirm} disabled={isPending || !inputSatisfied}>
                {isPending ? "Working..." : (confirmLabel ?? label)}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
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
