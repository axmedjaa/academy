import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getBatch } from "@/lib/academies/batches";
import {
  listBatchEnrollments,
  listBatchTrainerAssignments,
  listMyAssignedBatches,
} from "@/lib/academies/batch-assignments";
import { listStaff } from "@/lib/academies/staff";
import { searchStudents } from "@/lib/academies/students";
import { getCourse } from "@/lib/academies/courses";
import { RosterPanel } from "./roster-panel";
import { Badge, PAGE_WRAP, PageMessage } from "@/app/academy/_shell/ui";

/**
 * PLAN.md Phase 3, Item 44 — batch detail/roster view: assigned trainers +
 * enrolled students for one batch. Extends app/academy/batches/page.tsx's
 * list (Item 43) with a per-batch detail route rather than folding the
 * roster into the list page itself, per this item's own brief ("check
 * app/academy/batches/page.tsx's existing structure ... to decide whether
 * to extend it or add a new route").
 */
export default async function BatchRosterPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const batchResult = await getBatch(context, batchId);
  if (!batchResult.ok) {
    return (
      <PageMessage
        title={batchResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={batchResult.error.message}
      />
    );
  }

  const [assignmentsResult, enrollmentsResult, staffResult, studentsResult, myAssignedResult, courseResult] =
    await Promise.all([
      listBatchTrainerAssignments(context, batchId),
      listBatchEnrollments(context, batchId),
      listStaff(context),
      searchStudents(context),
      listMyAssignedBatches(context),
      // Best-effort, same non-fatal convention as every other page's display
      // enrichment: only used for the "Course" label below the batch name.
      getCourse(context, batchResult.batch.courseId),
    ]);
  const courseName = courseResult.ok ? courseResult.course.name : null;

  const assignments = assignmentsResult.ok ? assignmentsResult.assignments : [];
  const enrollments = enrollmentsResult.ok ? enrollmentsResult.enrollments : [];
  const staffOptions = staffResult.ok ? staffResult.staff : [];
  const studentOptions = studentsResult.ok ? studentsResult.data.rows : [];
  const canManage = assignmentsResult.ok ? assignmentsResult.canManage : false;
  const canDeleteEnrollment = enrollmentsResult.ok ? enrollmentsResult.canDelete : false;
  // "A Trainer viewing their batches" convenience — see
  // lib/academies/batch-assignments.ts's module comment on
  // getAssignedBatchIds/listMyAssignedBatches.
  const isAssignedToMe = myAssignedResult.ok && myAssignedResult.batchIds.includes(batchId);

  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink sm:text-2xl">
            {batchResult.batch.name} <span className="font-normal text-muted">({batchResult.batch.code})</span>
          </h1>
          <p className="mt-1 text-sm text-muted">{courseName ? `Course: ${courseName}` : "Course unavailable"}</p>
        </div>
        <Badge label={batchResult.batch.status} tone={batchResult.batch.status === "archived" ? "gray" : "green"} />
        {isAssignedToMe && <Badge label="You are assigned to teach this batch" tone="blue" />}
      </div>
      <RosterPanel
        batchId={batchId}
        assignments={assignments}
        enrollments={enrollments}
        staffOptions={staffOptions.map((s) => ({ id: s.id, fullName: s.fullName }))}
        studentOptions={studentOptions.map((s) => ({ id: s.id, fullName: s.fullName, studentNumber: s.studentNumber }))}
        canManage={canManage}
        canDeleteEnrollment={canDeleteEnrollment}
      />
    </div>
  );
}
