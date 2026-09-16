import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listAcademies, type AcademySummary } from "@/lib/academies/approve";
import type { SubscriptionStatus } from "@/lib/subscriptions/state-machine";

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

// DESIGN.md §11.1's derived subscription badge, applied here to the list
// page's new "Subscription" column — a second, separate badge from the
// approval-derived one above (statusLabel/statusColor track
// academies.approved_at/closed_at; these two track
// academy_subscriptions.status). Duplicated in
// app/platform/academies/[id]/page.tsx rather than shared — see that file's
// own comment on subscriptionStatusLabel/subscriptionStatusColor for why.
function subscriptionStatusLabel(status: SubscriptionStatus | null): string {
  if (status === null) return "No subscription";
  switch (status) {
    case "draft":
      return "Draft";
    case "trial":
      return "Trial";
    case "active":
      return "Active";
    case "past_due":
      return "Past Due";
    case "suspended":
      return "Suspended";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

function subscriptionStatusColor(status: SubscriptionStatus | null): string {
  if (status === null) return "#9ca3af";
  switch (status) {
    case "active":
      return "#0a7d2c";
    case "trial":
      return "#2563eb";
    case "draft":
      return "#6b7280";
    case "past_due":
      return "#b45309";
    case "suspended":
    case "expired":
    case "cancelled":
      return "#b91c1c";
    default:
      return "#6b7280";
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
        DESIGN.md §8's column list for this screen: "name, status badge
        (derived — §11.1), plan, branch count, student count." Approval
        status (pending-approval vs. approved vs. closed, derived from
        approved_at/closed_at) and the separate subscription-lifecycle badge
        (derived from academy_subscriptions.status, §11.1) are both shown —
        two distinct derived states, never conflated into one column. Plan
        name and branch count are real, joined data (lib/academies/
        approve.ts's listAcademies()). Student count is deliberately NOT
        rendered: no `students` table exists anywhere in this codebase yet
        (same gap lib/subscriptions/usage.ts's countActiveStudents stub
        documents) — inventing a number here would be exactly the kind of
        fake data this item's brief says not to render.
      */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1.5rem" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>Name</th>
            <th style={{ textAlign: "left" }}>Slug</th>
            <th style={{ textAlign: "left" }}>Approval</th>
            <th style={{ textAlign: "left" }}>Plan</th>
            <th style={{ textAlign: "left" }}>Subscription</th>
            <th style={{ textAlign: "left" }}>Branches</th>
            <th style={{ textAlign: "left" }}>Created</th>
            <th style={{ textAlign: "left" }}></th>
          </tr>
        </thead>
        <tbody>
          {academies.length === 0 && (
            <tr>
              <td colSpan={8}>No academies registered yet.</td>
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
              <td>{academy.planName ?? "—"}</td>
              <td>
                <span
                  style={{
                    color: subscriptionStatusColor(academy.subscriptionStatus),
                    fontWeight: 600,
                  }}
                >
                  {subscriptionStatusLabel(academy.subscriptionStatus)}
                </span>
              </td>
              <td>{academy.branchCount}</td>
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
