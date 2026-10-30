import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getStaffWorkplaceOptions, listStaff } from "@/lib/academies/staff";
import { StaffTable } from "./staff-table";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { RegisterStaffButton } from "./register-staff-form";

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
export default async function StaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const [result, workplace, params] = await Promise.all([
    listStaff(context),
    getStaffWorkplaceOptions(context),
    searchParams,
  ]);
  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  const canManage = result.permissionLevel === "full" || result.permissionLevel === "manage";

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Staff"
        description="People who work at this academy. Roles, branches and status are edited on the row; there is no staff detail page."
        actions={canManage ? (
            <RegisterStaffButton
              workplaceOptions={workplace.ok ? workplace.options : null}
              openedByUrl={params.register === "1"}
            />
          ) : undefined}
      />
      <StaffTable
        staff={result.staff}
        canManage={canManage}
        canDelete={result.canDelete}
        workplaceOptions={workplace.ok ? workplace.options : null}
      />
    </div>
  );
}
