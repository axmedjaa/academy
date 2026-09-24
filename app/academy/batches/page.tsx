import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listBatches } from "@/lib/academies/batches";
import { listBranches } from "@/lib/academies/branches";
import { listCourses } from "@/lib/academies/courses";
import { BatchesList } from "./batches-list";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";

/**
 * PLAN.md Item 43: `/academy/batches` — batch CRUD, the one entity in this
 * item that's branch-scoped (see lib/academies/batches.ts's module
 * comment). Same gating shape as app/academy/branches/page.tsx.
 */
export default async function AcademyBatchesPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const result = await listBatches(context);

  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  // Best-effort: only used to populate the "Branch"/"Course" selects on the
  // create form — listBranches already applies the same branch-scoping for
  // branch-limited roles (Trainer), so a Trainer only ever sees their own
  // assigned branch(es) here too.
  const branchesResult = await listBranches(context);
  const branchOptions = branchesResult.ok ? branchesResult.branches : [];
  const coursesResult = await listCourses(context);
  const courseOptions = coursesResult.ok ? coursesResult.courses : [];

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Batches"
        description={
          result.canManage
            ? "You can create, edit, and archive batches in your scope."
            : "You can view the batch(es) in your scope."
        }
      />
      <BatchesList
        batches={result.batches}
        branches={branchOptions}
        courses={courseOptions}
        canManage={result.canManage}
        canDelete={result.canDelete}
      />
    </div>
  );
}
