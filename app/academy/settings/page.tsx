import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getAcademySettings, getOwnAcademyUsage } from "@/lib/academies/settings";
import { getNotificationPreferences } from "@/lib/notifications/preferences";
import { AcademySettingsForm } from "./settings-form";
import { AcademyUsageWidget } from "./academy-usage-widget";
import { NotificationPreferencesSection } from "./notification-preferences-section";

/**
 * PLAN.md Item 41: `/academy/settings` — expanded profile fields (direct
 * edit) + own-academy usage widget.
 *
 * `app/academy/layout.tsx` (Item 28) already gated the whole `/academy/*`
 * subtree for base subscription-status access (redirect to /login when
 * unauthenticated, a full-page block for closed/suspended/expired/etc.).
 * That layout has no channel to hand this page the academyId/role it
 * resolved, so this page repeats a `checkAcademyAccessForContext`-backed
 * lookup of its own — done inside `getAcademySettings`/`getOwnAcademyUsage`
 * themselves (lib/academies/settings.ts), not duplicated here. This page's
 * own job is only: redirect if somehow unauthenticated (defensive, matches
 * every other page in this codebase's gating convention,
 * e.g. app/platform/staff/page.tsx), then render whichever of
 * blocked/forbidden/success each read returns.
 *
 * A "blocked" result here (the access-gate call inside settings.ts
 * disagreeing with the layout's own, separate call a moment earlier) is a
 * defensive, expected-to-be-unreachable race — e.g. the academy is closed
 * in the instant between the two checks. `AcademySettingsActionError` only
 * carries a generic "blocked" code + message (not the granular
 * `AcademyAccessDenyReason` the layout's own `AcademyAccessMessage`
 * component keys off), so this renders a calm, generic message rather than
 * reusing that component with a guessed/wrong reason.
 */
export default async function AcademySettingsPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const [settingsResult, usageResult] = await Promise.all([
    getAcademySettings(context),
    getOwnAcademyUsage(context),
  ]);

  // Phase 5, Item 59 addition (additive — the rest of this page/its two
  // existing reads above are untouched): DESIGN.md §9.11's "Notification
  // Settings | C (toggle list) | Per §9.8" row. Only fetched once the
  // academy id is known (needs `settingsResult.academy.id`); a failed
  // `settingsResult` already short-circuits the whole page below, so this
  // read is skipped rather than attempted against a nonexistent academyId.
  const preferencesResult = settingsResult.ok
    ? await getNotificationPreferences(context, settingsResult.academy.id)
    : null;

  if (!settingsResult.ok) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{settingsResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{settingsResult.error.message}</p>
      </main>
    );
  }

  return (
    <main
      style={{
        maxWidth: 720,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Academy settings</h1>

      {usageResult.ok ? (
        <AcademyUsageWidget
          planName={usageResult.planName}
          usage={usageResult.usage}
          limits={usageResult.limits}
        />
      ) : null}

      <AcademySettingsForm
        academy={settingsResult.academy}
        permissionLevel={settingsResult.permissionLevel}
      />

      {preferencesResult?.ok ? (
        <NotificationPreferencesSection
          academyId={settingsResult.academy.id}
          preferences={preferencesResult.preferences}
        />
      ) : null}
    </main>
  );
}
