"use client";

import { useState } from "react";
import type { ZodType } from "zod";

export type FieldErrors = Record<string, string>;

/**
 * Instant, client-side pre-submit validation using the same kind of Zod
 * schema this codebase already writes server-side for every form (e.g.
 * lib/academies/settings.ts's `updateAcademySettingsSchema`) — this is
 * purely an additional feedback layer bound to a form's `onSubmit`. The
 * server action's own Zod validation remains the actual authority and is
 * completely unchanged by this; a client schema here is a UX convenience,
 * never a security boundary.
 *
 * Deliberately no new component library or form library (no shadcn/ui, no
 * react-hook-form) — just Zod (already a core dependency) plus this one
 * small hook, rendered with whatever field/error UI the calling form
 * already uses (app/academy/_shell/ui.tsx's `Field`, or the older
 * lib/ui/auth-components.tsx styles on the auth pages).
 *
 * Server Action files ("use server") may only export async functions, so a
 * form's client-side schema can't literally import the matching
 * server-side schema — each form defines its own small mirror instead,
 * commented with which server schema it mirrors.
 */
/** Pure, framework-free core: `null` on success, or one message per field
 * (first issue wins) on failure — kept separate from the hook below so it's
 * directly unit-testable without rendering a component. */
export function parseFieldErrors<T>(schema: ZodType<T>, values: unknown): FieldErrors | null {
  const result = schema.safeParse(values);
  if (result.success) return null;

  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "_form");
    if (!errors[key]) errors[key] = issue.message;
  }
  return errors;
}

export function useFieldErrors<T>(schema: ZodType<T>) {
  const [errors, setErrors] = useState<FieldErrors>({});

  /** Validates `values` (typically `Object.fromEntries(new FormData(form))`)
   * and updates field-keyed error state. Returns whether it passed. */
  function validate(values: unknown): boolean {
    const fieldErrors = parseFieldErrors(schema, values);
    setErrors(fieldErrors ?? {});
    return fieldErrors === null;
  }

  function clearErrors(): void {
    setErrors({});
  }

  return { errors, validate, clearErrors };
}
