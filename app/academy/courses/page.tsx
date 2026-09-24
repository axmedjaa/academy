import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listCourses } from "@/lib/academies/courses";
import { listPrograms } from "@/lib/academies/programs";
import { listStaff } from "@/lib/academies/staff";
import { CoursesList } from "./courses-list";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";

/**
 * PLAN.md Item 43: `/academy/courses` — course CRUD, `checkAllowance('courses')`
 * enforced server-side inside `createCourse`. Same gating shape as
 * app/academy/branches/page.tsx.
 */
export default async function AcademyCoursesPage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const result = await listCourses(context);

  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  // Best-effort: only used to populate the "Program" select on the create
  // form. If the caller can't list programs for some reason, the form
  // simply renders with no options rather than failing the whole page.
  const programsResult = await listPrograms(context);
  const programs = programsResult.ok ? programsResult.programs : [];

  // Best-effort, same convention: populates the "Instructor" select. Any
  // active staff member may be picked (not filtered to a "trainer" role) —
  // the simple model doesn't otherwise restrict who can be a course's
  // instructor.
  const staffResult = await listStaff(context);
  const instructors = staffResult.ok ? staffResult.staff.filter((s) => s.status === "active") : [];

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Courses"
        description={
          result.canManage
            ? "You can create, edit, and archive courses."
            : "You can view this academy's courses."
        }
      />
      <CoursesList
        courses={result.courses}
        programs={programs}
        instructors={instructors.map((s) => ({ id: s.id, fullName: s.fullName }))}
        canManage={result.canManage}
      />
    </div>
  );
}
