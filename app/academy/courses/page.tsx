import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listCourses } from "@/lib/academies/courses";
import { listPrograms } from "@/lib/academies/programs";
import { listStaff } from "@/lib/academies/staff";
import { CoursesList } from "./courses-list";
import { PAGE_WRAP, PageMessage } from "@/app/academy/_shell/ui";

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

  // Perf investigation (Afoogy slow-dashboard task): these three reads are
  // mutually independent — `listPrograms`/`listStaff` only ever populate
  // this page's create-form dropdowns and don't use anything `listCourses`
  // returns — but were previously awaited sequentially. None of the three
  // is inside a shared transaction, so running them concurrently uses
  // separate pool connections and is real wall-clock parallelism (measured:
  // ~2.3s sequential -> ~1.3s, bounded by the slowest of the three). Each
  // keeps its own existing "best-effort, empty array on failure" handling;
  // `listPrograms`/`listStaff` running even when `listCourses` itself fails
  // is harmless (their own `resolveXAccess` checks still gate them
  // independently, and their results are simply never used below).
  const [result, programsResult, staffResult] = await Promise.all([
    listCourses(context),
    listPrograms(context),
    listStaff(context),
  ]);

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
  const programs = programsResult.ok ? programsResult.programs : [];

  // Best-effort, same convention: populates the "Instructor" select. Any
  // active staff member may be picked (not filtered to a "trainer" role) —
  // the simple model doesn't otherwise restrict who can be a course's
  // instructor.
  const instructors = staffResult.ok ? staffResult.staff.filter((s) => s.status === "active") : [];

  return (
    <div className={PAGE_WRAP}>
      <CoursesList
        courses={result.courses}
        programs={programs}
        instructors={instructors.map((s) => ({ id: s.id, fullName: s.fullName }))}
        canManage={result.canManage}
      />
    </div>
  );
}
