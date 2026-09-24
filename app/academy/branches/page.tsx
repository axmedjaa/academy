import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listBranches } from "@/lib/academies/branches";
import { BranchesList } from "./branches-list";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";

/**
 * PLAN.md Item 34: `/academy/branches` — branch CRUD.
 *
 * Same gating shape as app/academy/settings/page.tsx (Item 41): the
 * `/academy/*` layout (Item 28) already ran a base subscription/membership
 * check, but has no channel to hand this page the resolved academyId/role,
 * so this page's own read (`listBranches`) repeats a
 * `checkAcademyAccessForContext`-backed lookup itself (inside
 * lib/academies/branches.ts, not duplicated here).
 */
export default async function AcademyBranchesPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const result = await listBranches(context);

  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Branches"
        description={
          result.canManage
            ? "You can create, edit, and archive branches."
            : "You can view the branch(es) you're assigned to."
        }
      />
      <BranchesList branches={result.branches} canManage={result.canManage} />
    </div>
  );
}
