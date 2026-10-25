import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listBatches, type BatchRecord } from "@/lib/academies/batches";
import {
  listBatchEnrollments,
  listBatchTrainerAssignments,
  listMyAssignedBatches,
} from "@/lib/academies/batch-assignments";
import { listBranches } from "@/lib/academies/branches";
import { listCourses } from "@/lib/academies/courses";
import { listPrograms } from "@/lib/academies/programs";
import { listStaff } from "@/lib/academies/staff";
import { searchStudents } from "@/lib/academies/students";
import { getStudentsOverview } from "@/lib/academies/students-overview";
import type { EnrollBatchOption } from "@/lib/academies/enroll-options";
import { getEnrollmentFeeSchedule } from "@/lib/academies/fee-periods";
import { listAcademyTimetable } from "@/lib/academies/timetables";
import { DAYS_OF_WEEK, DAY_LABELS, formatTimetableTime } from "@/lib/academies/timetable-constants";
import { formatDate } from "@/lib/ui/date";
import { formatMoney } from "@/lib/ui/money";
import { describePaymentPlan } from "@/lib/ui/payment-plan";
import { BackLink, Badge, PAGE_WRAP, PageHeader, PageMessage, humanizeStatus, trHover } from "@/app/academy/_shell/ui";
import { BlockTitle, DataTable, KvCard, NoteBlock, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import {
  BatchHeaderActions,
  EmptyCard,
  EnrolledStudentsTable,
  TrainersTable,
  type EnrollmentRow,
} from "./batch-detail";

const STATUS_TONE: Record<BatchRecord["status"], "blue" | "green" | "slate" | "gray"> = {
  planned: "blue",
  active: "green",
  completed: "slate",
  archived: "gray",
};

/**
 * Batch detail (design A08 detail): back link; "CODE, Course + Course"
 * with branch, status and course count; Enroll a student / Assign trainer /
 * Edit batch; the Batch key-value card; the courses in this batch (with
 * how many students take each); classes by course; trainers; and enrolled
 * students per course with their fee plan. Every read is the scoped read
 * the rest of the console uses, and fee details appear only for roles that
 * may see fees. Reads here never create records (fee plans are read with
 * `getEnrollmentFeeSchedule`, which does not generate fee periods).
 */
export default async function BatchDetailPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const batchesResult = await listBatches(context);
  if (!batchesResult.ok) {
    return (
      <PageMessage
        title={batchesResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={batchesResult.error.message}
      />
    );
  }
  const batch = batchesResult.batches.find((row) => row.id === batchId);
  if (!batch) {
    return <PageMessage title="Not found" message="Batch not found." />;
  }

  const [
    assignmentsResult,
    enrollmentsResult,
    staffResult,
    studentsResult,
    myAssignedResult,
    coursesResult,
    programsResult,
    branchesResult,
    timetableResult,
    overviewResult,
  ] = await Promise.all([
    listBatchTrainerAssignments(context, batchId),
    listBatchEnrollments(context, batchId),
    listStaff(context),
    searchStudents(context, { status: "active" }, { pageSize: 100 }),
    listMyAssignedBatches(context),
    listCourses(context),
    listPrograms(context),
    listBranches(context),
    listAcademyTimetable(context),
    getStudentsOverview(context, { branchId: batch.branchId }),
  ]);

  const courses = coursesResult.ok ? coursesResult.courses : [];
  const programs = programsResult.ok ? programsResult.programs : [];
  const branches = branchesResult.ok ? branchesResult.branches : [];
  const programName = new Map(programs.map((p) => [p.id, p.name]));
  const batchCourses = batch.courseIds
    .map((id) => courses.find((c) => c.id === id))
    .filter((c): c is (typeof courses)[number] => Boolean(c));
  const courseNameById = new Map(courses.map((c) => [c.id, c.name]));
  const courseTitle = batchCourses.map((c) => c.name).join(" + ") || "Courses unavailable";
  const branchName = branches.find((b) => b.id === batch.branchId)?.name ?? "Branch unavailable";

  const assignments = assignmentsResult.ok ? assignmentsResult.assignments : [];
  const rawEnrollments = enrollmentsResult.ok ? enrollmentsResult.enrollments : [];
  const canManageRoster = assignmentsResult.ok ? assignmentsResult.canManage : false;
  const canDeleteEnrollment = enrollmentsResult.ok ? enrollmentsResult.canDelete : false;
  const isAssignedToMe = myAssignedResult.ok && myAssignedResult.batchIds.includes(batchId);

  // Fee plan per enrollment (read-only), shown only when the caller may see fees.
  const schedules = await Promise.all(rawEnrollments.map((e) => getEnrollmentFeeSchedule(context, e.id)));
  const showFees = schedules.length > 0 && schedules.every((s) => s.ok);
  const overdueByStudent = overviewResult.ok ? overviewResult.overview.finance?.overdueByStudent ?? {} : {};
  const enrollments: EnrollmentRow[] = rawEnrollments.map((enrollment, index) => {
    const result = schedules[index];
    const schedule = result.ok ? result.schedule : null;
    const overdue = (overdueByStudent[enrollment.studentId] ?? []).map((t) => formatMoney(t.amountCents, t.currency)).join(" + ");
    return {
      ...enrollment,
      courseName: courseNameById.get(enrollment.courseId) ?? "Unavailable course",
      feePlan: schedule ? describePaymentPlan(schedule.amountCents, schedule.intervalMonths, schedule.currency) : null,
      overdue: overdue || null,
    };
  });

  // Courses each student already takes here; the enroll dialog marks them.
  const enrolledPairs: Record<string, string[]> = {};
  for (const e of rawEnrollments) {
    if (e.status !== "active") continue;
    (enrolledPairs[e.studentId] ??= []).push(`${e.batchId}:${e.courseId}`);
  }
  const activeCountByCourse = new Map<string, number>();
  for (const e of rawEnrollments) {
    if (e.status === "active") activeCountByCourse.set(e.courseId, (activeCountByCourse.get(e.courseId) ?? 0) + 1);
  }
  const studentRows = studentsResult.ok ? studentsResult.data.rows : [];
  const studentOptions = studentRows.map((s) => ({ id: s.id, fullName: s.fullName, studentNumber: s.studentNumber }));
  const enrollBatch: EnrollBatchOption | null =
    (batch.status === "planned" || batch.status === "active") && batchCourses.length > 0
      ? {
          id: batch.id,
          code: batch.code,
          name: batch.name,
          branchId: batch.branchId,
          branchName,
          status: batch.status,
          startDate: batch.startDate,
          courses: batchCourses.map((c) => ({ id: c.id, name: c.name })),
        }
      : null;
  const studentsTruncated = studentsResult.ok && studentsResult.data.totalCount > studentRows.length;
  const staffOptions = (staffResult.ok ? staffResult.staff : [])
    .filter((s) => s.status === "active")
    .map((s) => ({ id: s.id, fullName: s.fullName }));
  const activeTrainerIds = assignments.filter((a) => a.status === "active").map((a) => a.staffProfileId);

  // One row per weekly class: entries sharing course, time, trainer and room.
  const entries = timetableResult.ok ? timetableResult.entries.filter((e) => e.batchId === batchId) : [];
  const classes = new Map<string, { entry: (typeof entries)[number]; days: Set<(typeof entries)[number]["dayOfWeek"]> }>();
  for (const entry of entries) {
    const key = [entry.courseId, entry.startTime, entry.endTime, entry.trainerStaffProfileId ?? "", entry.room ?? ""].join("|");
    const existing = classes.get(key);
    if (existing) existing.days.add(entry.dayOfWeek);
    else classes.set(key, { entry, days: new Set([entry.dayOfWeek]) });
  }
  const classRows = [...classes.values()].sort(
    (a, b) => a.entry.courseName.localeCompare(b.entry.courseName) || a.entry.startTime.localeCompare(b.entry.startTime),
  );

  const branchOptions = branches.map((b) => ({ id: b.id, name: b.name, status: b.status }));
  const courseOptions = courses.map((c) => ({
    id: c.id,
    name: c.name,
    code: c.code,
    programName: programName.get(c.programId) ?? null,
    durationWeeks: c.durationWeeks,
    status: c.status,
  }));

  return (
    <div className={PAGE_WRAP}>
      <BackLink href="/academy/batches" label="All batches" />
      <PageHeader
        title={`${batch.code}, ${courseTitle}`}
        description={[
          branchName,
          humanizeStatus(batch.status),
          `${batchCourses.length} course${batchCourses.length === 1 ? "" : "s"}`,
        ].join(" · ")}
        actions={
          <BatchHeaderActions
            batch={batch}
            enrollBatch={enrollBatch}
            enrolledPairs={enrolledPairs}
            students={studentOptions}
            studentsTruncated={studentsTruncated}
            staff={staffOptions}
            activeTrainerIds={activeTrainerIds}
            branches={branchOptions}
            courses={courseOptions}
            canManage={canManageRoster}
            canEdit={batchesResult.canManage}
          />
        }
      />

      <KvCard
        title="Batch"
        rows={[
          ["Name", batch.name],
          ["Branch", branchName],
          ["Dates", `${formatDate(batch.startDate)} to ${formatDate(batch.endDate, "no end date")}`],
          [
            "Status",
            <span key="s" className="inline-flex flex-wrap items-center gap-2">
              <Badge label={batch.status} tone={STATUS_TONE[batch.status]} />
              {isAssignedToMe && <Badge label="You teach this batch" tone="blue" />}
            </span>,
          ],
        ]}
      />

      <BlockTitle>Courses in this batch</BlockTitle>
      {batchCourses.length > 0 ? (
        <DataTable stackBelow={760}>
          <thead>
            <tr>
              <th className={rtTh}>Course</th>
              <th className={rtTh}>Program</th>
              <th className={rtTh}>Instructor</th>
              <th className={rtTh}>Length</th>
              <th className={rtTh}>Students</th>
            </tr>
          </thead>
          <tbody>
            {batchCourses.map((course) => (
              <tr key={course.id} className={trHover}>
                <td className={rtTd} data-label="Course">
                  <Link
                    href={`/academy/courses/${course.id}`}
                    className="inline-flex min-h-11 items-center font-semibold !text-brand no-underline hover:underline"
                  >
                    {course.name}
                    {course.code ? ` (${course.code})` : ""}
                  </Link>
                </td>
                <td className={rtTd} data-label="Program">
                  {programName.get(course.programId) ?? <span className="text-muted">Unknown</span>}
                </td>
                <td className={rtTd} data-label="Instructor">
                  {course.instructorName ?? <span className="text-muted">Not assigned</span>}
                </td>
                <td className={rtTd} data-label="Length">
                  {course.durationWeeks ? `${course.durationWeeks} weeks` : <span className="text-muted">Not set</span>}
                </td>
                <td className={`${rtTd} tabular-nums`} data-label="Students">
                  {activeCountByCourse.get(course.id) ?? 0}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        <EmptyCard message="This batch's courses aren't available to you." />
      )}

      <NoteBlock>
        Each course in a batch has its own classes, students, exams and fee plans. A student enrolls in the courses they
        take, not the whole batch.
      </NoteBlock>

      {timetableResult.ok && (
        <>
          <BlockTitle
            actions={
              <Link href="/academy/timetable" className="text-sm font-semibold !text-brand no-underline hover:underline">
                Open timetable
              </Link>
            }
          >
            Classes by course
          </BlockTitle>
          {classRows.length === 0 ? (
            <EmptyCard message="No classes scheduled yet." />
          ) : (
            <DataTable stackBelow={600}>
              <thead>
                <tr>
                  <th className={rtTh}>Course</th>
                  <th className={rtTh}>Days</th>
                  <th className={rtTh}>Time</th>
                  <th className={rtTh}>Trainer</th>
                  <th className={rtTh}>Room</th>
                </tr>
              </thead>
              <tbody>
                {classRows.map(({ entry, days }) => (
                  <tr key={entry.id} className={trHover}>
                    <td className={`${rtTd} font-semibold`} data-label="Course">
                      {entry.courseName}
                    </td>
                    <td className={rtTd} data-label="Days">
                      {DAYS_OF_WEEK.filter((d) => days.has(d))
                        .map((d) => DAY_LABELS[d])
                        .join(", ")}
                    </td>
                    <td className={`${rtTd} whitespace-nowrap tabular-nums`} data-label="Time">
                      {formatTimetableTime(entry.startTime)} to {formatTimetableTime(entry.endTime)}
                    </td>
                    <td className={rtTd} data-label="Trainer">
                      {entry.trainerName ?? <span className="text-muted">No trainer yet</span>}
                    </td>
                    <td className={rtTd} data-label="Room">
                      {entry.room ?? <span className="text-muted">Not set</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </>
      )}

      <TrainersTable batchId={batchId} assignments={assignments} canManage={canManageRoster} />

      <EnrolledStudentsTable
        batchId={batchId}
        enrollments={enrollments}
        canManage={canManageRoster}
        canDelete={canDeleteEnrollment}
        showFees={showFees}
      />
    </div>
  );
}
