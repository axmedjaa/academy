import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listAcademies, type AcademySummary } from "@/lib/academies/approve";
import type { SubscriptionStatus } from "@/lib/subscriptions/state-machine";
import {
  Badge,
  LinkButton,
  PAGE_WRAP,
  PageHeader,
  PageMessage,
  TableWrap,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";

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

function statusTone(status: AcademySummary["status"]): "green" | "gray" | "amber" {
  switch (status) {
    case "approved":
      return "green";
    case "closed":
      return "gray";
    case "pending_approval":
    default:
      return "amber";
  }
}

// DESIGN.md §11.1's derived subscription badge, applied here to the list
// page's new "Subscription" column — a second, separate badge from the
// approval-derived one above (statusLabel/statusTone track
// academies.approved_at/closed_at; these two track
// academy_subscriptions.status). Duplicated in
// app/platform/academies/[id]/page.tsx rather than shared — see that file's
// own comment on subscriptionStatusLabel/subscriptionStatusTone for why.
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

function subscriptionStatusTone(status: SubscriptionStatus | null): "green" | "blue" | "gray" | "amber" | "red" {
  if (status === null) return "gray";
  switch (status) {
    case "active":
      return "green";
    case "trial":
      return "blue";
    case "draft":
      return "gray";
    case "past_due":
      return "amber";
    case "suspended":
    case "expired":
    case "cancelled":
      return "red";
    default:
      return "gray";
  }
}

export default async function AcademiesPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, ACADEMIES_CAPABILITY);

  if (!allowed) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  const academies = await listAcademies();

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Academies"
        description="Every academy registered on the platform, its approval state, and its subscription."
        actions={<LinkButton href="/platform/academies/new">Register new academy</LinkButton>}
      />

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
      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Name</th>
            <th className={th}>Slug</th>
            <th className={th}>Approval</th>
            <th className={th}>Plan</th>
            <th className={th}>Subscription</th>
            <th className={th}>Branches</th>
            <th className={th}>Created</th>
            <th className={th}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {academies.length === 0 && (
            <tr>
              <td colSpan={8} className={`${td} text-center text-muted`}>
                No academies registered yet.
              </td>
            </tr>
          )}
          {academies.map((academy) => (
            <tr key={academy.id} className={trHover}>
              <td className={`${td} font-medium`}>{academy.name}</td>
              <td className={td}>{academy.slug}</td>
              <td className={td}>
                <Badge label={statusLabel(academy.status)} tone={statusTone(academy.status)} />
              </td>
              <td className={td}>{academy.planName ?? "—"}</td>
              <td className={td}>
                <Badge
                  label={subscriptionStatusLabel(academy.subscriptionStatus)}
                  tone={subscriptionStatusTone(academy.subscriptionStatus)}
                />
              </td>
              <td className={td}>{academy.branchCount}</td>
              <td className={td}>{academy.createdAt.toLocaleDateString()}</td>
              <td className={td}>
                <LinkButton href={`/platform/academies/${academy.id}`} variant="secondary" className="px-2.5 py-1 text-xs">
                  View
                </LinkButton>
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </div>
  );
}
