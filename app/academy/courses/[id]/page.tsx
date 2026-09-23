import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getCourse, listCourseEnrollments } from "@/lib/academies/courses";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const ENROLLMENT_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  withdrawn: "Withdrawn",
  completed: "Completed",
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
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>{courseResult.error.code === "blocked" ? "Access unavailable" : "Not found"}</h1>
        <p>{courseResult.error.message}</p>
      </main>
    );
  }
  const { course } = courseResult;

  const enrollmentsResult = await listCourseEnrollments(context, courseId);
  const enrollments = enrollmentsResult.ok ? enrollmentsResult.enrollments : [];
  const activeCount = enrollments.filter((e) => e.status === "active").length;

  return (
    <main
      style={{
        maxWidth: 800,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <p>
        <Link href="/academy/courses">← Back to courses</Link>
      </p>

      <div style={{ display: "flex", gap: "1.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        {course.imageRef && (
          // eslint-disable-next-line @next/next/no-img-element -- see app/academy/id-cards/id-card-visual.tsx precedent
          <img
            src={course.imageRef}
            alt=""
            style={{ width: 200, height: 120, objectFit: "cover", borderRadius: 6, flexShrink: 0 }}
          />
        )}
        <div>
          <h1 style={{ margin: 0 }}>{course.name}</h1>
          <p style={{ color: "#666", margin: "0.25rem 0" }}>
            {course.code ? `Code: ${course.code} · ` : ""}Status: {course.status}
          </p>
          {course.description && <p>{course.description}</p>}
          <dl style={{ display: "grid", gridTemplateColumns: "140px 1fr", rowGap: "0.4rem" }}>
            <dt style={{ color: "#666" }}>Instructor</dt>
            <dd style={{ margin: 0 }}>{course.instructorName ?? "—"}</dd>
            <dt style={{ color: "#666" }}>Starts</dt>
            <dd style={{ margin: 0 }}>{formatDate(course.startDate)}</dd>
            <dt style={{ color: "#666" }}>Ends</dt>
            <dd style={{ margin: 0 }}>{formatDate(course.endDate)}</dd>
            {course.durationWeeks !== null && (
              <>
                <dt style={{ color: "#666" }}>Duration</dt>
                <dd style={{ margin: 0 }}>{course.durationWeeks} weeks</dd>
              </>
            )}
            <dt style={{ color: "#666" }}>Enrolled students</dt>
            <dd style={{ margin: 0 }}>{activeCount}</dd>
          </dl>
        </div>
      </div>

      <h2 style={{ marginTop: "2rem" }}>Enrolled students</h2>
      {enrollments.length === 0 ? (
        <p style={{ color: "#666" }}>No students are enrolled in this course yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: "0.5rem" }}>Student #</th>
              <th style={{ padding: "0.5rem" }}>Name</th>
              <th style={{ padding: "0.5rem" }}>Batch</th>
              <th style={{ padding: "0.5rem" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {enrollments.map((enrollment) => (
              <tr key={`${enrollment.studentId}-${enrollment.batchId}`} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "0.5rem" }}>{enrollment.studentNumber}</td>
                <td style={{ padding: "0.5rem" }}>{enrollment.studentFullName}</td>
                <td style={{ padding: "0.5rem" }}>{enrollment.batchName}</td>
                <td style={{ padding: "0.5rem" }}>{ENROLLMENT_STATUS_LABEL[enrollment.status] ?? enrollment.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
