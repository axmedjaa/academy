import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listAcademyTimetable } from "@/lib/academies/timetables";
import { listBatches } from "@/lib/academies/batches";
import { listBranches } from "@/lib/academies/branches";
import { listCourses } from "@/lib/academies/courses";
import { listStaffSummaries } from "@/lib/academies/staff";
import { TimetableList } from "./timetable-list";
import { PAGE_WRAP, PageMessage } from "@/app/academy/_shell/ui";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";

/**
 * PLAN.md Item 45: `/academy/timetable` — academy-wide timetable CRUD, no
 * attendance fields anywhere (Decision #21). Same gating shape as
 * app/academy/batches/page.tsx.
 */
export default async function AcademyTimetablePage() {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  // Performance plan P4: these reads are independent of each other, so they
  // run together instead of one after another. Each one still applies its
  // own gate and scoping, and the option lists below stay best-effort
  // exactly as before (a failed list just leaves its select empty).
  const [result, branchesResult, batchesResult, coursesResult, staffResult, access] = await Promise.all([
    listAcademyTimetable(context),
    listBranches(context),
    listBatches(context),
    listCourses(context),
    // Only id and name are used here, so the lighter read (same gate and
    // visibility as listStaff, no deletion-eligibility counts) is enough.
    listStaffSummaries(context),
    checkAcademyAccessForContext(context),
  ]);

  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  // Best-effort: populates the Branch/Course/Batch/Instructor selects on the
  // create form — all already apply the same branch-scoping (for
  // branch-limited roles) or permission gating the timetable action itself
  // uses, so nothing here widens access beyond what the caller already has.
  const branchOptions = branchesResult.ok ? branchesResult.branches : [];
  const batchOptions = batchesResult.ok ? batchesResult.batches : [];
  // Courses are academy-wide (no branch_id of their own — see
  // lib/academies/timetables.ts's own module comment); "courses available
  // at a branch" is derived client-side from batchOptions, not from a
  // courses.branch_id column that doesn't exist.
  const courseOptions = coursesResult.ok ? coursesResult.courses : [];
  const staffOptions = staffResult.ok ? staffResult.staff.map((s) => ({ id: s.id, fullName: s.fullName })) : [];

  // Display-only: the academy name for the timetable card's eyebrow, from
  // the access gate's own academy row (the layout already passed the gate).
  const academyName = access.level !== "blocked" ? access.academy.name || "Academy" : "Academy";

  return (
    <div className={PAGE_WRAP}>
      <TimetableList
        academyName={academyName}
        entries={result.entries}
        branches={branchOptions}
        batches={batchOptions}
        courses={courseOptions}
        staffOptions={staffOptions}
        canManage={result.canManage}
      />
    </div>
  );
}
