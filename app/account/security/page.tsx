import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext, getCurrentSessionId } from "@/lib/auth/auth-context";
import { hasVerifiedMfaCredential } from "@/lib/auth/mfa";
import { getPendingEmailChange } from "@/lib/auth/email-change";
import { listMySessions, revokeAllOtherSessions, revokeSession } from "@/lib/auth/session-actions";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getAccountIdentity } from "@/lib/console/shell-data";
import { describeUserAgent } from "@/lib/ui/user-agent";
import { Badge, PageHeader } from "@/app/academy/_shell/ui";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";
import { ACCOUNT_WRAP, AccountTabs, notificationsHrefFor } from "../account-tabs";
import { ChangeEmailButton, ChangePasswordButton, PendingEmailNotice } from "./account-forms";

const CARD = "mb-5 rounded-card border border-border bg-surface p-5 shadow-card";
const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

/**
 * Account settings (design S01): profile, email, password, active sessions,
 * two-step verification and a link to Activity. Every read and action is
 * the signed-in user's own: `listMySessions` / `revokeSession` /
 * `revokeAllOtherSessions` (IDOR-checked per session), `updateOwnAccount`
 * for email and password, and `hasVerifiedMfaCredential` for Platform
 * Owners, the only accounts two-step verification applies to. Name and
 * phone come from the caller's staff record; there is no self-service edit
 * for them, so they are shown read-only.
 */
export default async function AccountSecurityPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const access = context.platformRole ? null : await checkAcademyAccessForContext(context);
  const academy = access && access.level !== "blocked" ? { academyId: access.academyId, role: access.membershipRole } : null;

  const [sessions, currentSessionId, mfaEnabled, identity, pendingEmailChange] = await Promise.all([
    listMySessions(),
    getCurrentSessionId(),
    context.platformRole === "platform_owner" ? hasVerifiedMfaCredential(context.userId) : Promise.resolve(null),
    getAccountIdentity(context, academy),
    getPendingEmailChange(context.userId),
  ]);
  const others = sessions.filter((session) => session.id !== currentSessionId);
  // This device first, then the most recent sign-ins.
  const ordered = [...sessions].sort(
    (a, b) => Number(b.id === currentSessionId) - Number(a.id === currentSessionId) || b.createdAt.getTime() - a.createdAt.getTime(),
  );

  return (
    <div className={ACCOUNT_WRAP}>
      <AccountTabs current="settings" notificationsHref={notificationsHrefFor(identity.console)} />
      <PageHeader title="Account settings" description="Your profile, sign-in details and security." />

      <section className={CARD} aria-labelledby="profile-heading">
        <div className="mb-4 flex items-center gap-3">
          <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand-tint text-base font-bold text-brand">
            {initialsOf(identity.name)}
          </span>
          <div className="min-w-0">
            <h2 id="profile-heading" className="text-base font-semibold text-ink [overflow-wrap:anywhere]">
              {identity.name}
            </h2>
            {identity.roleLabel && (
              <span className="mt-0.5 inline-flex rounded-full bg-brand-tint px-2.5 py-0.5 text-xs font-semibold text-brand">{identity.roleLabel}</span>
            )}
          </div>
        </div>
        <dl className="grid gap-4 sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-[13px] font-semibold text-ink">Full name</dt>
            <dd className="mt-1.5 rounded-lg border border-border bg-app px-3 py-2.5 text-[15px] text-ink [overflow-wrap:anywhere]">{identity.name}</dd>
          </div>
          {identity.console === "academy" && (
            <div className="min-w-0">
              <dt className="text-[13px] font-semibold text-ink">Phone</dt>
              <dd className="mt-1.5 rounded-lg border border-border bg-app px-3 py-2.5 text-[15px] tabular-nums text-ink">
                {identity.phone || "Not given"}
              </dd>
            </div>
          )}
          {identity.roleLabel && (
            <div className="min-w-0">
              <dt className="text-[13px] font-semibold text-ink">Role</dt>
              <dd className="mt-1.5 rounded-lg border border-border bg-app px-3 py-2.5 text-[15px] text-muted">{identity.roleLabel}</dd>
            </div>
          )}
        </dl>
        <p className="mt-3 text-xs text-muted">
          {identity.console === "academy"
            ? "Your name and phone come from your staff record, and your role is set by your academy. Ask someone who manages staff to change them."
            : "Your role is set by the Platform Owner. You cannot change your own."}
        </p>
      </section>

      <section className={CARD} aria-labelledby="email-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-[1_1_260px]">
            <h2 id="email-heading" className="text-sm font-semibold text-ink">
              Email address
            </h2>
            <p className="mt-1 text-[15px] text-ink [overflow-wrap:anywhere]">{identity.email}</p>
            <p className="mt-1 text-xs text-muted">You sign in with this address. Changing it needs your current password and a confirmation link.</p>
          </div>
          <ChangeEmailButton />
        </div>
        {pendingEmailChange?.newEmail && <PendingEmailNotice pendingEmail={pendingEmailChange.newEmail} />}
      </section>

      <section className={`${CARD} mb-9`} aria-labelledby="password-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-[1_1_260px]">
            <h2 id="password-heading" className="text-sm font-semibold text-ink">
              Password
            </h2>
            <p className="mt-1 text-[13px] text-muted">Use at least 8 characters. Changing it signs out your other sessions.</p>
          </div>
          <ChangePasswordButton />
        </div>
      </section>

      <h2 className="text-[22px] font-bold leading-tight text-ink">Security</h2>
      <p className="mb-4 mt-1 text-muted">
        {context.platformRole === "platform_owner" ? "Sessions, two-step verification and recovery codes." : "Where you are signed in."}
      </p>

      <section className={CARD} aria-labelledby="sessions-heading">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <h3 id="sessions-heading" className="text-sm font-semibold text-ink">
            Active sessions
          </h3>
          {others.length > 0 && (
            <form action={revokeAllOtherSessions}>
              <button type="submit" className={ROW_BTN}>
                Sign out everywhere else
              </button>
            </form>
          )}
        </div>
        <ul role="list">
          {ordered.map((session) => {
            const { device, browser } = describeUserAgent(session.userAgent);
            const current = session.id === currentSessionId;
            return (
              <li key={session.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-3 last:border-b-0 last:pb-0">
                <span className="min-w-0 flex-[1_1_180px]">
                  <span className="block font-semibold text-ink">{device}</span>
                  {browser && <span className="block text-xs text-muted">{browser}</span>}
                </span>
                <span className="min-w-0 flex-1 text-xs text-muted sm:min-w-[150px] sm:flex-none sm:text-right">
                  <span className="block font-mono text-[13px] text-ink">{session.ip && session.ip !== "unknown" ? session.ip : "IP not recorded"}</span>
                  <span className="block">{current ? "Active now" : `Signed in ${WHEN.format(session.createdAt)}`}</span>
                </span>
                <span className="flex justify-end sm:w-[104px]">
                  {current ? (
                    <Badge label="This device" tone="green" />
                  ) : (
                    <form action={revokeSession.bind(null, session.id)}>
                      <button type="submit" className={ROW_BTN} aria-label={`Revoke the session on ${device}${browser ? `, ${browser}` : ""}`}>
                        Revoke
                      </button>
                    </form>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {context.platformRole === "platform_owner" && (
        <section className={CARD} aria-labelledby="mfa-heading">
          <h3 id="mfa-heading" className="text-sm font-semibold text-ink">
            Two-step verification
          </h3>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <span className="flex flex-wrap items-center gap-3 text-[13px] text-muted">
              {mfaEnabled ? <Badge label="Enabled" tone="green" /> : <Badge label="Not enabled" tone="gray" />}
              Required for Platform Owner accounts.
            </span>
            <Link
              href={mfaEnabled ? "/mfa/recovery-codes" : "/mfa/setup"}
              className={mfaEnabled ? ROW_BTN : `${ROW_BTN} !border-brand !bg-brand !text-white hover:!bg-brand-hover`}
            >
              {mfaEnabled ? "Regenerate recovery codes" : "Set up two-step verification"}
            </Link>
          </div>
        </section>
      )}

      <section className={CARD} aria-labelledby="activity-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 id="activity-heading" className="text-sm font-semibold text-ink">
              Account activity
            </h3>
            <p className="mt-1 text-[13px] text-muted">Sign-ins and changes made on your account.</p>
          </div>
          <Link href="/account/activity" className={`${ROW_BTN} no-underline hover:no-underline`}>
            View activity
          </Link>
        </div>
      </section>
    </div>
  );
}
