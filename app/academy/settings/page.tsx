import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getAcademySettings, getOwnAcademyUsage } from "@/lib/academies/settings";
import { getAcademyLogoUrl } from "@/lib/academies/academy-logo";
import { getNotificationPreferences } from "@/lib/notifications/preferences";
import { EditProfileButton } from "./settings-form";
import { AcademyLogoUpload } from "./academy-logo-upload";
import { AcademyUsageWidget } from "./academy-usage-widget";
import { NotificationPreferencesSection } from "./notification-preferences-section";
import { PAGE_WRAP, PageHeader, PageMessage, PhoneLink } from "@/app/academy/_shell/ui";
import { KvCard, NoteBlock } from "@/app/academy/_shell/page-blocks";

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

  // Freshly generated per render — a signed R2 GET URL, never stored,
  // always short-lived (see lib/academies/academy-logo.ts's own comment on
  // why regenerating this on every server render is cheap and correct).
  const logoUrl = settingsResult.ok ? await getAcademyLogoUrl(settingsResult.academy.logoRef) : null;

  if (!settingsResult.ok) {
    return (
      <PageMessage
        title={settingsResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={settingsResult.error.message}
      />
    );
  }

  const academy = settingsResult.academy;
  const orNone = (value: string | null) => value || <span className="text-muted">Not set</span>;

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Settings"
        description="Academy profile, usage and notification preferences."
        actions={<EditProfileButton academy={academy} />}
      />

      <AcademyLogoUpload currentLogoUrl={logoUrl} />

      <KvCard
        title="Academy profile"
        rows={[
          ["Name", academy.name],
          ["Type", orNone(academy.type)],
          ["Address", orNone(academy.address)],
          ["Phone", academy.phone ? <PhoneLink phone={academy.phone} who={academy.name} /> : orNone(null)],
          ["Email", orNone(academy.email)],
          ["Website", orNone(academy.website)],
          ["Registration number", orNone(academy.registrationNumber)],
          [
            "Primary contact",
            academy.primaryContactName || academy.primaryContactPhone ? (
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {academy.primaryContactName}
                {academy.primaryContactPhone && <PhoneLink phone={academy.primaryContactPhone} who={academy.primaryContactName ?? undefined} />}
              </span>
            ) : (
              orNone(null)
            ),
          ],
          ["Slug (read-only)", <span key="slug" className="font-mono text-[13px]">{academy.slug}</span>],
          ["Default currency (read-only)", academy.defaultCurrency],
        ]}
      />

      {usageResult.ok ? (
        <AcademyUsageWidget planName={usageResult.planName} usage={usageResult.usage} limits={usageResult.limits} />
      ) : null}

      {preferencesResult?.ok ? (
        <NotificationPreferencesSection academyId={academy.id} preferences={preferencesResult.preferences} />
      ) : null}

      <NoteBlock>Profile changes save immediately; there is no approval step. Slug and default currency cannot be changed here.</NoteBlock>
    </div>
  );
}
