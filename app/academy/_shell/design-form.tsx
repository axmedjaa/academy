"use client";

import { useCallback, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Icon } from "./icons";
import { ChatActions } from "./chat-actions";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";

/**
 * The design's form system (Platform Console.dc.html `acForm` dialog, used
 * by every create/edit flow in academy-engine.js): a 560px dialog with a
 * title and supporting text, an optional tinted summary, a grid of labelled
 * 44px fields (required marker, per-field error tied to the control), a
 * count banner when several fields need attention, focus moved to the
 * first invalid field, and a grey footer with Cancel and the primary
 * action.
 *
 * Submitting goes through `onSubmit` rather than the form `action` prop so
 * a server-side error never resets what the user typed (React 19 resets
 * uncontrolled fields after an `action` submission). Every control stays
 * uncontrolled; values are read from FormData.
 */

export const fieldControl =
  "h-11 w-full rounded-lg border bg-surface px-3 text-[15px] font-normal text-ink placeholder:text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20 disabled:bg-app disabled:text-muted";
export const fieldControlArea =
  "w-full rounded-lg border bg-surface px-3 py-2.5 text-[15px] font-normal text-ink placeholder:text-muted focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20";
const borderFor = (invalid: boolean) => (invalid ? "border-[#B91C1C]" : "border-border-strong");

export function controlClass(invalid: boolean, area = false) {
  return `${area ? fieldControlArea : fieldControl} ${borderFor(invalid)}`;
}

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export function DesignDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  width = 560,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  width?: 560 | 640 | 720;
}) {
  const maxWidth = width === 720 ? "max-w-[720px]" : width === 640 ? "max-w-[640px]" : "max-w-[560px]";
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-[rgba(17,24,39,0.5)] animate-fade-in" />
        <div className="pointer-events-none fixed inset-0 z-[61] flex items-center justify-center p-4">
          <DialogPrimitive.Content
            onOpenAutoFocus={(event) => {
              // Start on the first field, as the design's form does, rather
              // than on the close button.
              const field = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(
                "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])",
              );
              if (field) {
                event.preventDefault();
                field.focus();
              }
            }}
            className={`pointer-events-auto flex max-h-[92vh] w-full ${maxWidth} flex-col overflow-hidden rounded-2xl bg-surface shadow-[0_24px_48px_rgba(17,24,39,0.32)] animate-scale-in focus:outline-none`}
          >
            <div className="flex items-start gap-3 border-b border-border px-6 pb-4 pt-5">
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="text-lg font-bold leading-snug text-ink">{title}</DialogPrimitive.Title>
                {description ? (
                  <DialogPrimitive.Description className="mt-1 text-[13px] leading-normal text-muted">
                    {description}
                  </DialogPrimitive.Description>
                ) : (
                  <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
                )}
              </div>
              <DialogPrimitive.Close
                aria-label="Close"
                className="-mr-2.5 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[#374151] transition-colors duration-150 hover:bg-app"
              >
                <Icon name="close" />
              </DialogPrimitive.Close>
            </div>
            {children}
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Scrollable dialog body. */
export function DialogBody({ children }: { children: ReactNode }) {
  // `relative` makes this scroller the containing block for absolutely
  // positioned descendants (the `sr-only` inputs behind course, batch and
  // choice chips). Without it they are placed against the dialog panel at
  // their unscrolled position, and focusing one scrolls the overflow-hidden
  // panel itself, sliding the whole form out of view (a blank dialog).
  return <div className="relative min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>;
}

/** Grey footer with Cancel and the primary action. */
export function DialogFooter({
  onCancel,
  submitLabel,
  pendingLabel,
  pending,
  danger,
  disabled,
  cancelLabel = "Cancel",
}: {
  onCancel: () => void;
  submitLabel: string;
  pendingLabel?: string;
  pending?: boolean;
  danger?: boolean;
  disabled?: boolean;
  cancelLabel?: string;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-3 border-t border-border bg-[#FAFBFC] px-6 py-4">
      <button
        type="button"
        onClick={onCancel}
        className="h-11 shrink-0 whitespace-nowrap rounded-lg border border-border-strong bg-surface px-[18px] font-medium text-ink transition-colors duration-150 hover:bg-app"
      >
        {cancelLabel}
      </button>
      <button
        type="submit"
        disabled={pending || disabled}
        className={`h-11 min-w-[120px] shrink-0 whitespace-nowrap rounded-lg border-0 px-5 font-semibold text-white transition-colors duration-150 disabled:opacity-60 ${
          danger ? "bg-[#B91C1C] hover:bg-[#991B1B]" : "bg-brand hover:bg-brand-hover"
        }`}
      >
        {pending ? (pendingLabel ?? `${submitLabel}…`) : submitLabel}
      </button>
    </div>
  );
}

/** The design's tinted summary block shown above a form's fields. */
export function FormSummary({ items }: { items: { label: string; value: ReactNode }[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-4 gap-y-2 rounded-xl border border-[#F0CDD5] bg-brand-tint px-3.5 py-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <div className="text-xs text-[#374151]">{item.label}</div>
          <div className="text-sm font-bold leading-snug tabular-nums [overflow-wrap:anywhere]">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Fields                                                              */
/* ------------------------------------------------------------------ */

/** `fill` keeps empty tracks, so a lone short field (Code, Phone) stays at
 * half width the way the design's two-column forms draw it. */
export function FieldGrid({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
  const tracks = fill ? "grid-cols-[repeat(auto-fill,minmax(220px,1fr))]" : "grid-cols-[repeat(auto-fit,minmax(220px,1fr))]";
  return <div className={`grid ${tracks} gap-4`}>{children}</div>;
}

export function DField({
  label,
  name,
  required,
  error,
  full,
  hint,
  group,
  children,
}: {
  label: string;
  /** Used for the error element id (`fe-{name}`) the control points at. */
  name: string;
  required?: boolean;
  error?: string;
  full?: boolean;
  hint?: ReactNode;
  /** For a set of controls (chips): a labelled group instead of a <label>. */
  group?: boolean;
  children: ReactNode;
}) {
  const Tag = group ? "div" : "label";
  return (
    <Tag
      {...(group ? { role: "group", "aria-labelledby": `fl-${name}` } : {})}
      className={`flex min-w-0 flex-col gap-1.5 text-[13px] font-semibold text-ink ${full ? "col-span-full" : ""}`}
    >
      <span id={group ? `fl-${name}` : undefined}>
        {label}
        {required && (
          <span aria-hidden="true" className="text-[#B91C1C]">
            {" "}
            *
          </span>
        )}
      </span>
      {children}
      {hint && !error && <span className="text-xs font-normal text-muted">{hint}</span>}
      {error && (
        <span id={`fe-${name}`} role="alert" className="flex items-start gap-1.5 text-xs font-medium leading-snug text-[#B91C1C]">
          <span
            aria-hidden="true"
            className="mt-px inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#B91C1C] text-[11px] font-bold text-white"
          >
            !
          </span>
          {error}
        </span>
      )}
    </Tag>
  );
}

/** Props that tie a control to its DField error. */
export function invalidProps(name: string, error?: string) {
  return error ? { "aria-invalid": true as const, "aria-describedby": `fe-${name}` } : {};
}

/** The design's phone field: tel input with WhatsApp / Telegram shortcuts
 * (official brand marks) once the number has enough digits. */
export function PhoneField({
  name,
  defaultValue,
  placeholder = "+252 63 400 0000",
  error,
  onBlur,
}: {
  name: string;
  defaultValue?: string | null;
  placeholder?: string;
  error?: string;
  onBlur?: () => void;
}) {
  const [value, setValue] = useState(defaultValue ?? "");
  // Offer the chat shortcuts once the number looks complete; ChatActions
  // disables them (with the reason) when it has no country code.
  const showChat = value.replace(/\D/g, "").length >= 8;
  return (
    <span
      className={`flex min-h-11 items-stretch overflow-hidden rounded-lg border bg-surface focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20 ${borderFor(Boolean(error))}`}
    >
      <input
        type="tel"
        name={name}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        inputMode="tel"
        autoComplete="tel"
        className="h-[42px] min-w-0 flex-1 border-0 bg-transparent px-3 text-[15px] font-normal text-ink outline-none placeholder:text-muted"
        {...invalidProps(name, error)}
      />
      {showChat && <ChatActions phone={value} variant="field" className="shrink-0" />}
    </span>
  );
}

export function FormErrorBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="mt-4 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2.5 text-[13px] text-[#991B1B]">
      {message}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export interface DesignFormRule {
  name: string;
  label: string;
  required?: boolean;
  /** Extra client check; return a message when invalid. */
  check?: (value: string, data: FormData) => string | null;
  /** "select" changes the required message to "Choose …". */
  kind?: "text" | "select";
}

/**
 * Design validation behaviour: required/format checks run on blur and on
 * submit; on submit every failing field is marked, a count banner appears
 * when more than one needs attention, and focus moves to the first invalid
 * control. `fieldForServerMessage` maps a server error onto a field the
 * same way the design does (by matching words in the message).
 */
export function useDesignForm(rules: DesignFormRule[]) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const messageFor = useCallback(
    (rule: DesignFormRule, value: string, data: FormData): string | null => {
      if (rule.required && value.trim() === "") {
        const label = rule.label.replace(/\s*\(.*?\)/g, "").trim();
        return rule.kind === "select" ? `Choose ${label.toLowerCase()}.` : `${label} is required.`;
      }
      return rule.check ? rule.check(value, data) : null;
    },
    [],
  );

  const focusFirstInvalid = useCallback(() => {
    window.setTimeout(() => {
      const el = formRef.current?.querySelector<HTMLElement>("[aria-invalid=true]");
      el?.focus();
    }, 40);
  }, []);

  /** Validates everything; returns true when the form may submit. */
  const validate = useCallback(
    (data: FormData): boolean => {
      const next: Record<string, string> = {};
      for (const rule of rules) {
        const message = messageFor(rule, String(data.get(rule.name) ?? ""), data);
        if (message) next[rule.name] = message;
      }
      setErrors(next);
      const count = Object.keys(next).length;
      setBanner(count > 1 ? `${count} fields need attention. They are marked below.` : null);
      if (count > 0) focusFirstInvalid();
      return count === 0;
    },
    [rules, messageFor, focusFirstInvalid],
  );

  /** onBlur handler for one field. */
  const blur = useCallback(
    (name: string) => () => {
      const rule = rules.find((r) => r.name === name);
      const form = formRef.current;
      if (!rule || !form) return;
      const data = new FormData(form);
      const message = messageFor(rule, String(data.get(name) ?? ""), data);
      setErrors((current) => {
        const next = { ...current };
        if (message) next[name] = message;
        else delete next[name];
        return next;
      });
    },
    [rules, messageFor],
  );

  /** Shows a server error on the matching field, or in the banner. */
  const showServerError = useCallback(
    (message: string, fieldPatterns: [RegExp, string][]) => {
      const hit = fieldPatterns.find(([pattern]) => pattern.test(message));
      if (hit) {
        setErrors({ [hit[1]]: message });
        setBanner(null);
        focusFirstInvalid();
      } else {
        setErrors({});
        setBanner(message);
      }
    },
    [focusFirstInvalid],
  );

  const reset = useCallback(() => {
    setErrors({});
    setBanner(null);
  }, []);

  return { formRef, errors, banner, validate, blur, showServerError, reset, setBanner };
}

/** Wraps a submit so the design's validation runs first. */
export function onDesignSubmit(validate: (data: FormData) => boolean, submit: (data: FormData) => void) {
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (!validate(data)) return;
    submit(data);
  };
}

/* ------------------------------------------------------------------ */
/* Choice chips                                                        */
/* ------------------------------------------------------------------ */

/** The design's `chips` field (Paid by, Refund): one choice from a short
 * list, drawn as selectable pills. Native radios underneath, so keyboard
 * and FormData work as usual. Use inside a `DField group`. */
export function ChoiceChips({
  name,
  options,
  defaultValue,
  onChange,
}: {
  name: string;
  options: { value: string; label: string; icon?: string }[];
  defaultValue?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <span className="flex flex-wrap gap-2">
      {options.map((option) => (
        <label
          key={option.value}
          className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border-strong bg-surface px-3.5 text-sm font-semibold text-ink transition-colors duration-150 hover:bg-app has-[:checked]:border-brand has-[:checked]:bg-brand-tint has-[:checked]:text-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/30"
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            defaultChecked={option.value === defaultValue}
            onChange={() => onChange?.(option.value)}
            className="sr-only"
          />
          {option.icon && <Icon name={option.icon} width={16} height={16} />}
          {option.label}
        </label>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Action dialog                                                       */
/* ------------------------------------------------------------------ */

/**
 * A small design form dialog for one action on an existing record (reverse,
 * adjust, reject, cancel, refund): optional summary, a few fields, and the
 * footer. `run` calls the server and resolves to an error message, or null
 * on success; a dropped connection becomes the usual network message and
 * the dialog stays open with what was typed.
 */
export function ActionDialog({
  open,
  onOpenChange,
  title,
  description,
  summary,
  submitLabel,
  pendingLabel,
  danger,
  rules,
  run,
  onDone,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  summary?: { label: string; value: ReactNode }[];
  submitLabel: string;
  pendingLabel?: string;
  danger?: boolean;
  rules: DesignFormRule[];
  run: (data: FormData) => Promise<string | null>;
  onDone: () => void;
  children: (form: { errors: Record<string, string>; blur: (name: string) => () => void }) => ReactNode;
}) {
  return (
    <DesignDialog open={open} onOpenChange={onOpenChange} title={title} description={description}>
      {open && (
        <ActionDialogForm
          summary={summary}
          submitLabel={submitLabel}
          pendingLabel={pendingLabel}
          danger={danger}
          rules={rules}
          run={run}
          onDone={onDone}
          onCancel={() => onOpenChange(false)}
        >
          {children}
        </ActionDialogForm>
      )}
    </DesignDialog>
  );
}

function ActionDialogForm({
  summary,
  submitLabel,
  pendingLabel,
  danger,
  rules,
  run,
  onDone,
  onCancel,
  children,
}: {
  summary?: { label: string; value: ReactNode }[];
  submitLabel: string;
  pendingLabel?: string;
  danger?: boolean;
  rules: DesignFormRule[];
  run: (data: FormData) => Promise<string | null>;
  onDone: () => void;
  onCancel: () => void;
  children: (form: { errors: Record<string, string>; blur: (name: string) => () => void }) => ReactNode;
}) {
  const { formRef, errors, banner, validate, blur, setBanner } = useDesignForm(rules);
  const [pending, startTransition] = useTransition();
  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) =>
        startTransition(async () => {
          let message: string | null;
          try {
            message = await run(data);
          } catch {
            message = NETWORK_ERROR_MESSAGE;
          }
          if (message) setBanner(message);
          else onDone();
        }),
      )}
    >
      <DialogBody>
        {summary && <FormSummary items={summary} />}
        <FieldGrid>{children({ errors, blur })}</FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel={submitLabel} pendingLabel={pendingLabel} pending={pending} danger={danger} />
    </form>
  );
}

/** The required Reason textarea most record actions ask for. */
export function ReasonField({
  errors,
  blur,
  label = "Reason",
  placeholder,
}: {
  errors: Record<string, string>;
  blur: (name: string) => () => void;
  label?: string;
  placeholder?: string;
}) {
  return (
    <DField label={label} name="reason" required error={errors.reason} full>
      <textarea
        name="reason"
        rows={3}
        maxLength={500}
        placeholder={placeholder}
        onBlur={blur("reason")}
        className={controlClass(Boolean(errors.reason), true)}
        {...invalidProps("reason", errors.reason)}
      />
    </DField>
  );
}
