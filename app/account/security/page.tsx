import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { getAuthContext, getCurrentSessionId } from "@/lib/auth/auth-context";
import { hasVerifiedMfaCredential } from "@/lib/auth/mfa";
import { getPendingEmailChange } from "@/lib/auth/email-change";
import { listMySessions, revokeAllOtherSessions, revokeSession } from "@/lib/auth/session-actions";
import { AuthLink, Card, Pill, SecondaryButton } from "@/lib/ui/auth-components";
import { color, spacing } from "@/lib/ui/theme";
import { AccountForms } from "./account-forms";

/** DESIGN.md §7: `/account/security` — "B. Active-sessions list (device/
 * browser, IP, last-active, 'this device' flag) with per-row Revoke +
 * 'Sign out of all other sessions.' For Platform Owner accounts only: an
 * MFA sub-section..." Pure restyle — `listMySessions`/`revokeSession`/
 * `revokeAllOtherSessions`/`hasVerifiedMfaCredential` are all unchanged,
 * still bound the same way (`revokeSession.bind(null, session.id)`). The
 * "Signed in" column label (not "last active") is preserved verbatim —
 * lib/auth/session.ts's own comment documents that no per-request activity
 * tracking exists, so this label stays honest rather than implying a
 * "last-active" column this schema was never asked to add. */
export default async function AccountSecurityPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const [sessions, currentSessionId, mfaEnabled, [user], pendingEmailChange] = await Promise.all([
    listMySessions(),
    getCurrentSessionId(),
    context.platformRole === "platform_owner" ? hasVerifiedMfaCredential(context.userId) : Promise.resolve(null),
    db.select({ email: users.email }).from(users).where(eq(users.id, context.userId)).limit(1),
    getPendingEmailChange(context.userId),
  ]);

  return (
    <div style={{ minHeight: "100vh", backgroundColor: color.bg, padding: spacing.xl }}>
      <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: spacing.xl }}>
        <div>
          <h1 style={{ margin: 0, color: color.text }}>Account security</h1>
          <p style={{ margin: 0, marginTop: spacing.xxs, color: color.textMuted }}>
            Manage where you&apos;re signed in and your account&apos;s two-factor authentication.
          </p>
        </div>

        <Card>
          <h2 style={{ margin: 0, marginBottom: spacing.xxs, fontSize: "1.05rem", color: color.text }}>Account</h2>
          <p style={{ margin: 0, marginBottom: spacing.md, fontSize: "0.85rem", color: color.textMuted }}>
            Update your email or password. Leave either blank to keep it as-is.
          </p>
          <AccountForms
            currentEmail={user?.email ?? ""}
            pendingNewEmail={pendingEmailChange?.newEmail ?? null}
          />
        </Card>

        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.md }}>
            <h2 style={{ margin: 0, fontSize: "1.05rem", color: color.text }}>Active sessions</h2>
            <form action={revokeAllOtherSessions}>
              <SecondaryButton type="submit">Sign out of all other sessions</SecondaryButton>
            </form>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: `1px solid ${color.border}` }}>
                  <th style={{ padding: "0.4rem 0", color: color.textMuted, fontWeight: 500 }}>Device / browser</th>
                  <th style={{ padding: "0.4rem 0", color: color.textMuted, fontWeight: 500 }}>IP</th>
                  <th style={{ padding: "0.4rem 0", color: color.textMuted, fontWeight: 500 }}>Signed in</th>
                  <th style={{ padding: "0.4rem 0" }} />
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id} style={{ borderBottom: `1px solid ${color.border}` }}>
                    <td style={{ padding: "0.5rem 0" }}>{session.userAgent ?? "Unknown"}</td>
                    <td style={{ padding: "0.5rem 0" }}>{session.ip ?? "Unknown"}</td>
                    <td style={{ padding: "0.5rem 0" }}>{session.createdAt.toLocaleString()}</td>
                    <td style={{ padding: "0.5rem 0", textAlign: "right" }}>
                      {session.id === currentSessionId ? (
                        <Pill label="This device" />
                      ) : (
                        <form action={revokeSession.bind(null, session.id)}>
                          <SecondaryButton type="submit">Revoke</SecondaryButton>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {context.platformRole === "platform_owner" && (
          <Card>
            <h2 style={{ margin: 0, marginBottom: spacing.sm, fontSize: "1.05rem", color: color.text }}>
              Two-factor authentication
            </h2>
            {mfaEnabled ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Pill label="Enabled" tone="blue" />
                <AuthLink href="/mfa/recovery-codes">Regenerate recovery codes</AuthLink>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Pill label="Not enabled" tone="gray" />
                <AuthLink
                  href="/mfa/setup"
                  style={{
                    backgroundColor: color.primaryBlue,
                    color: "#fff",
                    padding: "0.5rem 0.9rem",
                    borderRadius: 8,
                    fontWeight: 600,
                    fontSize: "0.85rem",
                  }}
                >
                  Set up two-factor authentication
                </AuthLink>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
