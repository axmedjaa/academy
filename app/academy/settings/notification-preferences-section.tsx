"use client";

import { useState, useTransition } from "react";
import { setNotificationPreferenceAction } from "@/lib/notifications/preferences-actions";
import { humanizeNotificationLabel } from "@/lib/notifications/humanize-template-id";
import type { NotificationPreferenceView } from "@/lib/notifications/preferences";

interface Props {
  academyId: string;
  preferences: NotificationPreferenceView[];
}

/**
 * DESIGN.md §9.11 "Notification Settings" row ("C (toggle list), Per
 * §9.8") + §9.8's own wording: "optional event types get a normal toggle;
 * mandatory ones... render as a disabled, always-on toggle labeled
 * 'Required — cannot be turned off' — never a togglable-looking control
 * that silently does nothing." Additive section on `/academy/settings`,
 * not a restructure of the existing Academy Profile form.
 *
 * Each row saves immediately on toggle (one `setNotificationPreferenceAction`
 * call per flip, via `useTransition`), same imperative-action convention as
 * app/platform/academies/[id]/approve-academy-button.tsx, rather than a
 * single bulk "Save" button — there is no unsaved/dirty state to lose here,
 * matching the Academy Profile section's own "changes save immediately, no
 * approval step" posture one section up on this same page.
 */
export function NotificationPreferencesSection({ academyId, preferences }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Optimistic local overrides, keyed by templateId — the server action
  // still re-validates and is the source of truth on the next full page
  // load (revalidatePath("/academy/settings")); this only avoids a visible
  // flicker back to the pre-toggle state while the request is in flight.
  const [localEnabled, setLocalEnabled] = useState<Record<string, boolean>>({});

  function handleToggle(templateId: string, nextEnabled: boolean) {
    setError(null);
    setLocalEnabled((prev) => ({ ...prev, [templateId]: nextEnabled }));
    startTransition(async () => {
      const result = await setNotificationPreferenceAction(academyId, templateId, nextEnabled);
      if (!result.ok) {
        // Revert the optimistic flip and surface the error (e.g. an
        // attempt to disable a mandatory template, which the UI itself
        // should already prevent by rendering that toggle disabled — this
        // is the defense-in-depth path if that ever disagrees).
        setLocalEnabled((prev) => ({ ...prev, [templateId]: !nextEnabled }));
        setError(result.error.message);
      }
    });
  }

  return (
    <section style={{ marginTop: "2rem" }}>
      <h2>Notification settings</h2>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        Choose which academy events you receive notifications for. Changes save immediately.
      </p>

      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}

      <ul style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        {preferences.map((preference) => {
          const enabled = localEnabled[preference.templateId] ?? preference.enabled;
          return (
            <li
              key={preference.templateId}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
                padding: "0.5rem 0.75rem",
                border: "1px solid #ddd",
                borderRadius: 4,
                maxWidth: 480,
              }}
            >
              <span>{humanizeNotificationLabel(preference.templateId)}</span>
              {preference.mandatory ? (
                <label
                  title="Required — cannot be turned off"
                  style={{ display: "flex", alignItems: "center", gap: "0.4rem", color: "#666" }}
                >
                  <input type="checkbox" checked disabled aria-label={`${preference.templateId} (required)`} />
                  Required — cannot be turned off
                </label>
              ) : (
                <label style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={isPending}
                    onChange={(event) => handleToggle(preference.templateId, event.target.checked)}
                    aria-label={preference.templateId}
                  />
                  {enabled ? "On" : "Off"}
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
