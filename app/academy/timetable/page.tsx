import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listAcademyTimetable } from "@/lib/academies/timetables";
import { listBatches } from "@/lib/academies/batches";
import { listBranches } from "@/lib/academies/branches";
import { listCourses } from "@/lib/academies/courses";
import { listStaff } from "@/lib/academies/staff";
import { TimetableList } from "./timetable-list";
import { PAGE_WRAP, PageMessage } from "@/app/academy/_shell/ui";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { db } from "@/lib/db";
import { academies } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

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

  const result = await listAcademyTimetable(context);

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
  const branchesResult = await listBranches(context);
  const branchOptions = branchesResult.ok ? branchesResult.branches : [];
  const batchesResult = await listBatches(context);
  const batchOptions = batchesResult.ok ? batchesResult.batches : [];
  // Courses are academy-wide (no branch_id of their own — see
  // lib/academies/timetables.ts's own module comment); "courses available
  // at a branch" is derived client-side from batchOptions, not from a
  // courses.branch_id column that doesn't exist.
  const coursesResult = await listCourses(context);
  const courseOptions = coursesResult.ok ? coursesResult.courses : [];
  // Same listStaff + { id, fullName } mapping already used by
  // app/academy/batches/[batchId]/page.tsx's "Assign trainer" field.
  const staffResult = await listStaff(context);
  const staffOptions = staffResult.ok ? staffResult.staff.map((s) => ({ id: s.id, fullName: s.fullName })) : [];

  // Display-only: the academy name for the timetable card's eyebrow. The
  // layout already passed the access gate; this resolves the caller's own
  // academy id the same way every page does.
  const access = await checkAcademyAccessForContext(context);
  const academyRow =
    access.level !== "blocked"
      ? await db.select({ name: academies.name }).from(academies).where(eq(academies.id, access.academyId)).limit(1)
      : [];
  const academyName = academyRow[0]?.name ?? "Academy";

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
