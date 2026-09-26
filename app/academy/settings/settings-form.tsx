"use client";

import { useActionState } from "react";
import {
  updateAcademySettings,
  type AcademySettingsFormState,
} from "@/lib/academies/settings-actions";
import type { AcademySettingsRecord } from "@/lib/academies/settings";
import { Button, ErrorMessage, Field, Section, inputClass } from "@/app/academy/_shell/ui";

const initialState: AcademySettingsFormState = { ok: false };

interface Props {
  academy: AcademySettingsRecord;
  /** "full" | "view_edit" | "view" | "manage" | "none" — see
   * lib/auth/academy-permissions.ts. The page only ever renders this form
   * once getAcademySettings has already confirmed the caller's role is not
   * "none", and for the one row that exists today ("academy.settings")
   * every non-"none" level is edit-capable (see that file's `manager`
   * comment) — so this only affects labeling, never whether the form is
   * shown or the Save button is enabled. */
  permissionLevel: string;
}

/**
 * PLAN.md Item 41 / DESIGN.md §9.11 "Academy Profile": one direct-edit form
 * (no approval step, no "pending change" state) for the full expanded
 * profile field set. `slug` and `defaultCurrency` are shown read-only, not
 * editable — see lib/academies/settings.ts's schema comment for why those
 * two columns are excluded from the editable set. The logo has its own
 * separate upload UI (academy-logo-upload.tsx, rendered alongside this
 * form by page.tsx) — no "Logo reference" field here anymore, per that
 * file's own comment on why logo management moved out of this general
 * update entirely.
 */
export function AcademySettingsForm({ academy, permissionLevel }: Props) {
  const [state, formAction, pending] = useActionState(updateAcademySettings, initialState);

  return (
    <Section>
      <h2 className="text-base font-semibold text-ink">Academy profile</h2>
      <p className="mt-1 text-sm text-muted">
        Access level: {permissionLevel === "full" ? "Full" : "View/Edit"}. Changes save
        immediately — there is no approval step.
      </p>

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted">Slug</dt>
        <dd className="text-ink">{academy.slug}</dd>
        <dt className="text-muted">Default currency</dt>
        <dd className="text-ink">{academy.defaultCurrency}</dd>
      </dl>

      <form action={formAction} className="mt-5 flex max-w-lg flex-col gap-3">
        <Field label="Name">
          <input type="text" name="name" defaultValue={academy.name} required className={inputClass} />
        </Field>
        <Field label="Type">
          <input type="text" name="type" defaultValue={academy.type ?? ""} className={inputClass} />
        </Field>
        <Field label="Address">
          <input type="text" name="address" defaultValue={academy.address ?? ""} className={inputClass} />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Phone">
            <input type="text" name="phone" defaultValue={academy.phone ?? ""} className={inputClass} />
          </Field>
          <Field label="Email">
            <input type="email" name="email" defaultValue={academy.email ?? ""} className={inputClass} />
          </Field>
        </div>
        <Field label="Website">
          <input type="text" name="website" defaultValue={academy.website ?? ""} className={inputClass} />
        </Field>
        <Field label="Registration number">
          <input
            type="text"
            name="registrationNumber"
            defaultValue={academy.registrationNumber ?? ""}
            className={inputClass}
          />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Primary contact name">
            <input
              type="text"
              name="primaryContactName"
              defaultValue={academy.primaryContactName ?? ""}
              className={inputClass}
            />
          </Field>
          <Field label="Primary contact phone">
            <input
              type="text"
              name="primaryContactPhone"
              defaultValue={academy.primaryContactPhone ?? ""}
              className={inputClass}
            />
          </Field>
        </div>

        {state.error && <ErrorMessage message={state.error.message} />}
        {state.ok && <p className="text-sm font-medium text-success">Saved.</p>}

        <Button type="submit" disabled={pending} className="self-start">
          {pending ? "Saving..." : "Save changes"}
        </Button>
      </form>
    </Section>
  );
}
