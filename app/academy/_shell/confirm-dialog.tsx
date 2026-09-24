"use client";

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { Button } from "./ui";

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
  /**
   * For maximum-consequence actions (e.g. permanently deleting an academy):
   * the Confirm button stays disabled until the typed value exactly matches
   * `requiredValue` — a plain "are you sure" click is not enough.
   */
  confirmInput?: { label: string; requiredValue: string };
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
  confirmInput,
}: ConfirmButtonProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [typedValue, setTypedValue] = useState("");

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

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
      onSuccess?.();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        className={className}
        disabled={disabled}
        onClick={() => {
          setError(null);
          setTypedValue("");
          setOpen(true);
        }}
      >
        {label}
      </Button>
      {open && (
        <div
          role="presentation"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-navy/40 p-4"
          onClick={() => !isPending && setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            className="w-full max-w-md rounded-card border border-border bg-surface p-5 shadow-card"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="confirm-dialog-title" className="text-base font-semibold text-ink">
              {title}
            </h2>
            <div className="mt-2 text-sm text-muted">{description}</div>
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
              <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={isPending}>
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
