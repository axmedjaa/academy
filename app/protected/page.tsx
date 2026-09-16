import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";

// Phase 0, Item 12: a temporary stub proving the auth+permission gate works
// end-to-end. No path is named in PLAN.md for this; real routes replace it
// starting Phase 1 (e.g. /platform/dashboard, Item 28).
export default async function ProtectedStubPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, "queryAuditLogs");

  if (!allowed) {
    // DESIGN.md Standard Screen States: "Permission-denied: a calm
    // full-section message... never a raw error page."
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to view this page.</p>
      </main>
    );
  }

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Protected stub</h1>
      <p>Auth + permission gate passed for user {context.userId}.</p>
    </main>
  );
}
