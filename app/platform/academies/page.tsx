import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listAcademies, type AcademySummary } from "@/lib/academies/approve";

// "approveAcademy" is in UNGRANTABLE_CAPABILITIES (lib/auth/permissions.ts),
// so hasPermission() returns true here only for platform_owner. DESIGN.md
// §5's Master Permission Matrix lists the whole "Academies (register/
// approve/activate/suspend/close)" area as "— (never grantable)" for
// platform_admin (a dash, not "View" — unlike academy_owner's "View own"),
// so gating the list page itself on this capability (not just the mutation)
// matches that row: the page is absent for every platform_admin regardless
// of grants, same as /platform/staff and /platform/plans.
const ACADEMIES_CAPABILITY = "approveAcademy";

function statusLabel(status: AcademySummary["status"]): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "closed":
      return "Closed";
    case "pending_approval":
    default:
      return "Pending approval";
  }
}

function statusColor(status: AcademySummary["status"]): string {
  switch (status) {
    case "approved":
      return "#0a7d2c";
    case "closed":
      return "#6b7280";
    case "pending_approval":
    default:
      return "#b45309";
  }
}

export default async function AcademiesPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, ACADEMIES_CAPABILITY);

  if (!allowed) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to view this page.</p>
      </main>
    );
  }

  const academies = await listAcademies();

  return (
    <main
      style={{
        maxWidth: 900,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h1>Academies</h1>
        <Link href="/platform/academies/new">Register new academy</Link>
      </div>

      {/*
        Shell scope (PLAN.md Item 21): distinguishes pending-approval vs.
        approved (derived from approved_at, per schema.ts — there is no
        status column). Deliberately no plan/branch-count/student-count
        columns yet — DESIGN.md §8's full column list for this screen
        ("plan, branch count, student count") depends on subscriptions
        (Items 22-25) and student records (a later phase), neither of
        which exist yet. Adding those columns now would mean either fake
        data or a schema/feature this item isn't scoped to build.
      */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1.5rem" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Name</th>
            <th style={{ textAlign: "left" }}>Slug</th>
            <th style={{ textAlign: "left" }}>Status</th>
            <th style={{ textAlign: "left" }}>Created</th>
            <th style={{ textAlign: "left" }}></th>
          </tr>
        </thead>
        <tbody>
          {academies.length === 0 && (
            <tr>
              <td colSpan={5}>No academies registered yet.</td>
            </tr>
          )}
          {academies.map((academy) => (
            <tr key={academy.id}>
              <td>{academy.name}</td>
              <td>{academy.slug}</td>
              <td>
                <span style={{ color: statusColor(academy.status), fontWeight: 600 }}>
                  {statusLabel(academy.status)}
                </span>
              </td>
              <td>{academy.createdAt.toLocaleDateString()}</td>
              <td>
                <Link href={`/platform/academies/${academy.id}`}>View</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
