import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { ACADEMY_STAFF_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { StaffForm } from "./staff-form";

/**
 * PLAN.md Item 35 — `/academy/staff/new`. Same gating shape as
 * app/academy/settings/page.tsx: `app/academy/layout.tsx` already checked
 * base subscription/membership access for the whole `/academy/*` subtree,
 * this page resolves its own academyId/role via
 * `checkAcademyAccessForContext` (no channel exists to receive the
 * layout's own resolved values), then additionally checks the
 * `academy.staff` row directly (rather than via `listStaff`, which this
 * page has no other use for) to decide whether to render the create form
 * at all — Trainer's "view" and Admissions/Finance's "none" both see
 * "Access denied" instead.
 */
export default async function NewStaffPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const access = await checkAcademyAccessForContext(context);
  if (access.level === "blocked") {
    if (access.reason === "not_authenticated") {
      redirect("/login");
    }
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access unavailable</h1>
        <p>{access.message}</p>
      </main>
    );
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (level !== "full" && level !== "manage") {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to add staff members.</p>
      </main>
    );
  }

  return (
    <main
      style={{
        maxWidth: 480,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Add staff member</h1>
      <StaffForm />
    </main>
  );
}
