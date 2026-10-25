"use client";

import { useState, useTransition } from "react";
import { setNotificationPreferenceAction } from "@/lib/notifications/preferences-actions";
import { humanizeNotificationLabel } from "@/lib/notifications/humanize-template-id";
import type { NotificationPreferenceView } from "@/lib/notifications/preferences";
import { ErrorMessage } from "@/app/academy/_shell/ui";

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
    <section className="mb-8 rounded-card border border-border bg-surface p-5 shadow-card" aria-labelledby="prefs-title">
      <h2 id="prefs-title" className="text-[15px] font-semibold text-ink">
        Notification preferences
      </h2>
      <p className="mt-0.5 text-[13px] text-muted">Choose which academy events notify you. Changes save immediately.</p>

      {error && (
        <div className="mt-3">
          <ErrorMessage message={error} />
        </div>
      )}

      <ul role="list" className="mt-3 divide-y divide-border">
        {preferences.map((preference) => {
          const label = humanizeNotificationLabel(preference.templateId);
          const on = preference.mandatory || (localEnabled[preference.templateId] ?? preference.enabled);
          return (
            <li key={preference.templateId} className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
              <span className="min-w-0 text-sm text-ink">
                {label}
                {preference.mandatory && <span className="block text-xs text-muted">Always on. Required notifications cannot be turned off.</span>}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={label}
                disabled={preference.mandatory || isPending}
                onClick={() => handleToggle(preference.templateId, !on)}
                className="group inline-flex min-h-11 shrink-0 items-center gap-2.5 text-[13px] font-semibold text-[#374151] disabled:cursor-not-allowed"
              >
                {on ? "On" : "Off"}
                <span
                  aria-hidden="true"
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150 ${on ? "bg-brand" : "bg-[#CBD5E1]"} ${preference.mandatory ? "opacity-60" : ""}`}
                >
                  <span
                    className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-150 motion-reduce:transition-none ${on ? "translate-x-[22px]" : "translate-x-0.5"}`}
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
