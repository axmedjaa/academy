import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listStaff } from "@/lib/academies/staff";
import { StaffTable } from "./staff-table";

/**
 * PLAN.md Item 35 — `/academy/staff`. Same gating shape as
 * app/academy/settings/page.tsx: `app/academy/layout.tsx` already gated
 * the `/academy/*` subtree for base subscription/membership access; this
 * page's own job is resolving+rendering whatever `listStaff` (Item 35's
 * own read path, lib/academies/staff.ts) returns.
 *
 * `listStaff` is deliberately academy-wide, not branch-scoped — see that
 * function's own doc comment: branch assignment/filtering is Item 36's
 * job, out of scope here.
 */
export default async function StaffPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const result = await listStaff(context);
  if (!result.ok) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{result.error.code === "blocked" ? "Access unavailable" : "Access denied"}</h1>
        <p>{result.error.message}</p>
      </main>
    );
  }

  const canManage = result.permissionLevel === "full" || result.permissionLevel === "manage";

  return (
    <main
      style={{
        maxWidth: 960,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Staff</h1>
        {canManage && <Link href="/academy/staff/new">Add staff member</Link>}
      </div>
      <StaffTable staff={result.staff} canManage={canManage} />
    </main>
  );
}
