import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { ACADEMY_STUDENTS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { listBranches } from "@/lib/academies/branches";
import { listBatches } from "@/lib/academies/batches";
import { listCourses } from "@/lib/academies/courses";
import { StudentForm } from "./student-form";

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
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access unavailable</h1>
        <p>{access.message}</p>
      </main>
    );
  }

  const level = getAcademyPermissionLevel(access.membershipRole, ACADEMY_STUDENTS_ACTION);
  if (level !== "full" && level !== "manage") {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to register students.</p>
      </main>
    );
  }

  const branchesResult = await listBranches(context);
  const branches = branchesResult.ok ? branchesResult.branches : [];

  // Course selection at registration time is really a batch selection (see
  // student-form.tsx's module comment on why) — best-effort, same
  // "non-fatal if the caller can't list them" convention as branches
  // above: joined here, in the page, rather than teaching batches.ts or
  // courses.ts about each other, since this is presentation-only.
  const [batchesResult, coursesResult] = await Promise.all([listBatches(context), listCourses(context)]);
  const courseNameById = new Map((coursesResult.ok ? coursesResult.courses : []).map((c) => [c.id, c.name]));
  const courseOptions = (batchesResult.ok ? batchesResult.batches : [])
    .filter((batch) => batch.status !== "archived")
    .map((batch) => ({
      batchId: batch.id,
      label: `${courseNameById.get(batch.courseId) ?? "Unknown course"} — ${batch.name}`,
    }));

  return (
    <main
      style={{
        maxWidth: 480,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <h1>Register student</h1>
      {branches.length === 0 ? (
        <p style={{ color: "#666" }}>
          No branch is available to register a student into yet. Ask an Owner/Admin to create or
          assign one first.
        </p>
      ) : (
        <StudentForm
          branches={branches.map((branch) => ({ id: branch.id, name: branch.name }))}
          courseOptions={courseOptions}
        />
      )}
    </main>
  );
}
