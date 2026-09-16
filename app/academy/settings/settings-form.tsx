"use client";

import { useActionState } from "react";
import {
  updateAcademySettings,
  type AcademySettingsFormState,
} from "@/lib/academies/settings-actions";
import type { AcademySettingsRecord } from "@/lib/academies/settings";

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
 * two columns are excluded from the editable set.
 */
export function AcademySettingsForm({ academy, permissionLevel }: Props) {
  const [state, formAction, pending] = useActionState(updateAcademySettings, initialState);

  return (
    <section style={{ marginTop: "2rem" }}>
      <h2>Academy profile</h2>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Access level: {permissionLevel === "full" ? "Full" : "View/Edit"}. Changes save
        immediately — there is no approval step.
      </p>

      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 1rem" }}>
        <dt>Slug</dt>
        <dd>{academy.slug}</dd>
        <dt>Default currency</dt>
        <dd>{academy.defaultCurrency}</dd>
      </dl>

      <form
        action={formAction}
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: 480 }}
      >
        <label>
          Name
          <input
            type="text"
            name="name"
            defaultValue={academy.name}
            required
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Type
          <input
            type="text"
            name="type"
            defaultValue={academy.type ?? ""}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Address
          <input
            type="text"
            name="address"
            defaultValue={academy.address ?? ""}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Phone
          <input
            type="text"
            name="phone"
            defaultValue={academy.phone ?? ""}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Email
          <input
            type="email"
            name="email"
            defaultValue={academy.email ?? ""}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Website
          <input
            type="text"
            name="website"
            defaultValue={academy.website ?? ""}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Logo reference
          <input
            type="text"
            name="logoRef"
            defaultValue={academy.logoRef ?? ""}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Registration number
          <input
            type="text"
            name="registrationNumber"
            defaultValue={academy.registrationNumber ?? ""}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Primary contact name
          <input
            type="text"
            name="primaryContactName"
            defaultValue={academy.primaryContactName ?? ""}
            style={{ display: "block", width: "100%" }}
          />
        </label>
        <label>
          Primary contact phone
          <input
            type="text"
            name="primaryContactPhone"
            defaultValue={academy.primaryContactPhone ?? ""}
            style={{ display: "block", width: "100%" }}
          />
        </label>

        {state.error && (
          <p role="alert" style={{ color: "crimson" }}>
            {state.error.message}
          </p>
        )}
        {state.ok && <p style={{ color: "green" }}>Saved.</p>}

        <button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save changes"}
        </button>
      </form>
    </section>
  );
}
