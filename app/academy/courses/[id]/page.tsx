import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getCourse, listCourseEnrollments, listCourses } from "@/lib/academies/courses";
import { listPrograms } from "@/lib/academies/programs";
import { listStaff } from "@/lib/academies/staff";
import { formatDate } from "@/lib/ui/date";
import { BackLink, Badge, PAGE_WRAP, PageHeader, PageMessage, trHover } from "@/app/academy/_shell/ui";
import { BlockTitle, DataTable, KvCard, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { CoursePictureCard, EditCourseButton } from "./course-detail-actions";

const ENROLLMENT_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  withdrawn: "Withdrawn",
  completed: "Completed",
};

const ENROLLMENT_STATUS_TONE: Record<string, "green" | "gray" | "slate"> = {
  active: "green",
  withdrawn: "gray",
  completed: "slate",
};

/**
 * Course detail (design A07 detail): back link, the course name with its
 * code and program, the Course picture block, the Course key-value card and
 * Enrolled students across every batch of the course. Administration only:
 * no lessons, modules or progress — this is not an LMS.
 */
export default async function CourseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: courseId } = await params;

  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const courseResult = await getCourse(context, courseId);
  if (!courseResult.ok) {
    return (
      <PageMessage
        title={courseResult.error.code === "blocked" ? "Access unavailable" : "Not found"}
        message={courseResult.error.message}
      />
    );
  }
  const { course } = courseResult;

  const [enrollmentsResult, coursesResult, programsResult, staffResult] = await Promise.all([
    listCourseEnrollments(context, courseId),
    listCourses(context),
    listPrograms(context),
    listStaff(context),
  ]);
  const enrollments = enrollmentsResult.ok ? enrollmentsResult.enrollments : [];
  const canManage = coursesResult.ok && coursesResult.canManage;
  const programs = programsResult.ok ? programsResult.programs : [];
  const programName = programs.find((program) => program.id === course.programId)?.name;
  const instructors = staffResult.ok
    ? staffResult.staff.filter((s) => s.status === "active").map((s) => ({ id: s.id, fullName: s.fullName }))
    : [];
  const activeCount = enrollments.filter((e) => e.status === "active").length;

  const dates =
    course.startDate || course.endDate
      ? `${formatDate(course.startDate, "Not set")} to ${formatDate(course.endDate, "Not set")}`
      : "Not set";

  return (
    <div className={PAGE_WRAP}>
      <BackLink href="/academy/courses" label="All courses" />
      <PageHeader
        title={course.name}
        description={[course.code, programName].filter(Boolean).join(" · ") || undefined}
        actions={canManage ? <EditCourseButton course={course} programs={programs} instructors={instructors} /> : undefined}
      />

      <CoursePictureCard course={course} canManage={canManage} />

      <KvCard
        title="Course"
        rows={[
          ["Duration", course.durationWeeks !== null ? `${course.durationWeeks} weeks` : <span key="d" className="text-muted">Not set</span>],
          ["Dates", dates],
          ["Instructor", course.instructorName ?? <span key="i" className="text-muted">Not assigned</span>],
          ["Status", <Badge key="s" label={course.status} tone={course.status === "archived" ? "gray" : "green"} />],
          ...(course.description ? ([["Description", course.description]] as [string, string][]) : []),
        ]}
      />

      <BlockTitle>
        Enrolled students{" "}
        <span className="font-normal text-muted">
          ({activeCount} active{enrollments.length !== activeCount ? `, ${enrollments.length} in total` : ""})
        </span>
      </BlockTitle>
      {enrollments.length === 0 ? (
        <div className="mb-8 rounded-card border border-border bg-surface px-4 py-8 text-center text-sm text-muted shadow-card">
          No students enrolled yet.
        </div>
      ) : (
        <DataTable stackBelow={600}>
          <thead>
            <tr>
              <th className={rtTh}>Student</th>
              <th className={rtTh}>Batch</th>
              <th className={rtTh}>Status</th>
            </tr>
          </thead>
          <tbody>
            {enrollments.map((enrollment) => (
              <tr key={`${enrollment.studentId}-${enrollment.batchId}`} className={trHover}>
                <td className={rtTd} data-label="Student">
                  <Link
                    href={`/academy/students/${enrollment.studentId}`}
                    className="flex min-h-11 flex-col justify-center no-underline hover:no-underline"
                  >
                    <span className="font-semibold !text-ink hover:underline">{enrollment.studentFullName}</span>
                    <span className="text-xs text-muted">{enrollment.studentNumber}</span>
                  </Link>
                </td>
                <td className={rtTd} data-label="Batch">
                  <Link
                    href={`/academy/batches/${enrollment.batchId}`}
                    className="inline-flex min-h-11 items-center !text-ink no-underline hover:underline"
                  >
                    {enrollment.batchName}
                  </Link>
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge
                    label={ENROLLMENT_STATUS_LABEL[enrollment.status] ?? enrollment.status}
                    tone={ENROLLMENT_STATUS_TONE[enrollment.status] ?? "gray"}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
