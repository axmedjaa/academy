import { redirect } from "next/navigation";
import { getAuthContext, getCurrentSessionId } from "@/lib/auth/auth-context";
import { hasVerifiedMfaCredential } from "@/lib/auth/mfa";
import {
  listMySessions,
  revokeAllOtherSessions,
  revokeSession,
} from "@/lib/auth/session-actions";

// DESIGN.md §7: "/account/security ... All (any authenticated user)."
export default async function AccountSecurityPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const [sessions, currentSessionId, mfaEnabled] = await Promise.all([
    listMySessions(),
    getCurrentSessionId(),
    context.platformRole === "platform_owner"
      ? hasVerifiedMfaCredential(context.userId)
      : Promise.resolve(null),
  ]);

  return (
    <main
      style={{
        maxWidth: 640,
        margin: "4rem auto",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Account security</h1>

      <section>
        <h2>Active sessions</h2>
        <form action={revokeAllOtherSessions}>
          <button type="submit">Sign out of all other sessions</button>
        </form>
        <table style={{ width: "100%", marginTop: "1rem", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left" }}>
              <th>Device / browser</th>
              <th>IP</th>
              <th>Signed in</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id} style={{ borderTop: "1px solid #ccc" }}>
                <td>{session.userAgent ?? "Unknown"}</td>
                <td>{session.ip ?? "Unknown"}</td>
                <td>{session.createdAt.toLocaleString()}</td>
                <td>
                  {session.id === currentSessionId ? (
                    <em>This device</em>
                  ) : (
                    <form action={revokeSession.bind(null, session.id)}>
                      <button type="submit">Revoke</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {context.platformRole === "platform_owner" && (
        <section style={{ marginTop: "2rem" }}>
          <h2>Two-factor authentication</h2>
          {mfaEnabled ? (
            <>
              <p>Enabled.</p>
              <a href="/mfa/recovery-codes">Regenerate recovery codes</a>
            </>
          ) : (
            <>
              <p>Not enabled.</p>
              <a href="/mfa/setup">Set up two-factor authentication</a>
            </>
          )}
        </section>
      )}
    </main>
  );
}
