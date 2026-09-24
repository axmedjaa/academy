import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { ACADEMY_STAFF_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { StaffForm } from "./staff-form";
import { PageHeader, PageMessage, Section } from "@/app/academy/_shell/ui";

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
    return <PageMessage title="Access unavailable" message={access.message} />;
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STAFF_ACTION);
  if (level !== "full" && level !== "manage") {
    return <PageMessage title="Access denied" message="You don't have permission to add staff members." />;
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-8 sm:px-6">
      <PageHeader title="Add staff member" />
      <Section>
        <StaffForm />
      </Section>
    </div>
  );
}
