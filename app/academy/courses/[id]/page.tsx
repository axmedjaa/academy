import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getCourse, listCourseEnrollments } from "@/lib/academies/courses";
import { Badge, PAGE_WRAP, PageMessage, Section, TableWrap, td, th, trHover } from "@/app/academy/_shell/ui";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const ENROLLMENT_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  withdrawn: "Withdrawn",
  completed: "Completed",
};

const ENROLLMENT_STATUS_TONE: Record<string, "green" | "gray" | "amber"> = {
  active: "green",
  withdrawn: "gray",
  completed: "amber",
};

/**
 * Simple Academy course-details view — administration only. Course
 * information (name/image/description/instructor/dates/status) plus who's
 * enrolled, aggregated across the course's batches via the existing
 * Student -> Batch -> Course relationship (lib/academies/courses.ts's
 * listCourseEnrollments). Deliberately does NOT contain any lessons/
 * modules/videos/progress — this is not an LMS, per the approved simple
 * course/enrollment model.
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

  const enrollmentsResult = await listCourseEnrollments(context, courseId);
  const enrollments = enrollmentsResult.ok ? enrollmentsResult.enrollments : [];
  const activeCount = enrollments.filter((e) => e.status === "active").length;

  return (
    <div className={PAGE_WRAP}>
      <Link href="/academy/courses" className="mb-4 inline-block text-sm text-brand hover:underline">
        ← Back to courses
      </Link>

      <Section className="flex flex-col gap-5 sm:flex-row sm:items-start">
        {course.imageRef && (
          // eslint-disable-next-line @next/next/no-img-element -- see app/academy/id-cards/id-card-visual.tsx precedent
          <img
            src={course.imageRef}
            alt={`${course.name} course cover`}
            className="h-32 w-full shrink-0 rounded-md object-cover sm:w-52"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-ink">{course.name}</h1>
            <Badge label={course.status} tone={course.status === "archived" ? "gray" : "green"} />
          </div>
          <p className="mt-1 text-sm text-muted">{course.code ? `Code: ${course.code}` : "No course code"}</p>
          {course.description && <p className="mt-3 text-sm text-ink">{course.description}</p>}

          <dl className="mt-4 grid grid-cols-[140px_1fr] gap-y-2 text-sm">
            <dt className="text-muted">Instructor</dt>
            <dd className="text-ink">{course.instructorName ?? "—"}</dd>
            <dt className="text-muted">Starts</dt>
            <dd className="text-ink">{formatDate(course.startDate)}</dd>
            <dt className="text-muted">Ends</dt>
            <dd className="text-ink">{formatDate(course.endDate)}</dd>
            {course.durationWeeks !== null && (
              <>
                <dt className="text-muted">Duration</dt>
                <dd className="text-ink">{course.durationWeeks} weeks</dd>
              </>
            )}
            <dt className="text-muted">Enrolled students</dt>
            <dd className="text-ink">{activeCount}</dd>
          </dl>
        </div>
      </Section>

      <h2 className="mb-3 mt-6 text-lg font-semibold text-ink">Enrolled students</h2>
      {enrollments.length === 0 ? (
        <Section>
          <p className="text-sm text-muted">No students are enrolled in this course yet.</p>
        </Section>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>Student #</th>
              <th className={th}>Name</th>
              <th className={th}>Batch</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {enrollments.map((enrollment) => (
              <tr key={`${enrollment.studentId}-${enrollment.batchId}`} className={trHover}>
                <td className={td}>{enrollment.studentNumber}</td>
                <td className={td}>{enrollment.studentFullName}</td>
                <td className={td}>{enrollment.batchName}</td>
                <td className={td}>
                  <Badge
                    label={ENROLLMENT_STATUS_LABEL[enrollment.status] ?? enrollment.status}
                    tone={ENROLLMENT_STATUS_TONE[enrollment.status] ?? "gray"}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
