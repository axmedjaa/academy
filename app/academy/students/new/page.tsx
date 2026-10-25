import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { ACADEMY_STUDENTS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { listBranches } from "@/lib/academies/branches";
import { getEnrollBatchOptions } from "@/lib/academies/enroll-options";
import { RegisterStudentCard } from "../register-student-form";
import { BackLink, PageMessage, Section } from "@/app/academy/_shell/ui";

/**
 * PLAN.md Item 38 — `/academy/students/new`. Same gating shape as
 * app/academy/staff/new/page.tsx (Item 35): `app/academy/layout.tsx`
 * already checked base subscription/membership access for the whole
 * `/academy/*` subtree, this page resolves its own academyId/role via
 * `checkAcademyAccessForContext` again (no channel exists to receive the
 * layout's own resolved values), then additionally checks the
 * `academy.students` row directly to decide whether to render the
 * registration form at all — Finance Officer's "view" and Trainer's
 * "view" (the matrix's "View assigned" cell) both see "Access denied"
 * instead, matching lib/academies/register-student.ts's own
 * full/manage-only gate on `registerStudent` itself.
 *
 * The branch <select> reuses `listBranches` (Item 34, read-only import —
 * not modified here) rather than re-deriving branch-scoping in this page:
 * that function already returns exactly the branch(es) the caller may
 * see (every branch for academy-wide roles, only the assigned branch(es)
 * for a branch-limited Admissions Officer), which is precisely the set
 * `registerStudent`'s own branch-limited check would accept — so a
 * branch-limited caller is never even shown a branch they'd be rejected
 * for picking.
 */
export default async function NewStudentPage() {
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

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STUDENTS_ACTION);
  if (level !== "full" && level !== "manage") {
    return <PageMessage title="Access denied" message="You don't have permission to register students." />;
  }

  const branchesResult = await listBranches(context);
  const branches = branchesResult.ok ? branchesResult.branches : [];

  // Optional enroll step: planned and active batches with their courses,
  // from the same scoped reads the batch pages use (non-fatal if empty).
  const { batches: enrollBatches } = await getEnrollBatchOptions(context);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-[560px]">
        <BackLink href="/academy/students" label="Back to students" />
      </div>
      {branches.length === 0 ? (
        <Section>
          <p className="text-sm text-muted">
            No branch is available to register a student into yet. Ask an Owner/Admin to create or assign one first.
          </p>
        </Section>
      ) : (
        <RegisterStudentCard
          branches={branches.map((branch) => ({ id: branch.id, name: branch.name }))}
          enrollBatches={enrollBatches}
        />
      )}
    </div>
  );
}
