import Link from "next/link";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { batchCourses, batches, courses, programs, students } from "@/lib/db/schema";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listCertificates } from "@/lib/academies/certificates";
import { getStudentPhotoUrlsByIds, searchStudents, STUDENTS_MAX_PAGE_SIZE } from "@/lib/academies/students";
import { listBatches } from "@/lib/academies/batches";
import { formatDate } from "@/lib/ui/date";
import { Badge, EmptyState, PAGE_WRAP, PageHeader, PageMessage, Section, trHover } from "@/app/academy/_shell/ui";
import { DataTable, NoteBlock, PersonCell, ROW_BTN, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ChipParamFilter, ClearFilters, FilterBar, FilterDropdown, SearchField } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { PaginationNav } from "@/components/pagination-nav";
import { CancelCertificateButton, IssueCertificateButton, VerifyCertificateCard, type CertificateBatchOption } from "./certificates-client";

const PAGE_SIZE = 15;

/**
 * Certificates (design A17): verify a code the way the public page does,
 * then browse this academy's certificates by status, year, batch and
 * search. Issue and Cancel are the existing audited actions; issuing still
 * needs a published, passing result in the batch, and a cancelled
 * certificate keeps verifying as cancelled.
 *
 * Certificates are per completed course (a multi-course batch can give a
 * student several), so each row shows its own course and that course's
 * program. Display enrichment (student, batch, course) reads only rows
 * whose ids came from the academy-scoped `listCertificates`, and is pinned
 * to the same academy.
 */
export default async function AcademyCertificatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const result = await listCertificates(context);
  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }
  const certificates = result.certificates;
  const academyId = certificates[0]?.academyId;
  const studentIds = [...new Set(certificates.map((c) => c.studentId))];
  const batchIds = [...new Set(certificates.map((c) => c.batchId))];
  const courseIds = [...new Set(certificates.map((c) => c.courseId))];

  const [studentRows, batchRows, courseRows, photos] = await Promise.all([
    academyId && studentIds.length
      ? db
          .select({ id: students.id, fullName: students.fullName, studentNumber: students.studentNumber })
          .from(students)
          .where(and(eq(students.academyId, academyId), inArray(students.id, studentIds)))
      : Promise.resolve([]),
    academyId && batchIds.length
      ? db
          .select({ id: batches.id, code: batches.code, name: batches.name })
          .from(batches)
          .where(and(eq(batches.academyId, academyId), inArray(batches.id, batchIds)))
      : Promise.resolve([]),
    academyId && courseIds.length
      ? db
          .select({ id: courses.id, name: courses.name, programName: programs.name })
          .from(courses)
          .innerJoin(programs, eq(programs.id, courses.programId))
          .where(and(eq(courses.academyId, academyId), inArray(courses.id, courseIds)))
      : Promise.resolve([]),
    getStudentPhotoUrlsByIds(context, studentIds),
  ]);
  const studentById = new Map(studentRows.map((row) => [row.id, row]));
  const batchById = new Map(batchRows.map((row) => [row.id, row]));
  const courseById = new Map(courseRows.map((row) => [row.id, row]));

  const params = await searchParams;
  const get = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  };
  const q = get("q").toLowerCase();
  const status = get("status");
  const year = get("year");
  const batchFilter = get("batch");
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const yearOf = (date: Date) => String(date.getFullYear());
  const base = certificates
    .filter((c) => !year || yearOf(c.issuedAt) === year)
    .filter((c) => !batchFilter || c.batchId === batchFilter)
    .filter((c) => {
      if (!q) return true;
      const batch = batchById.get(c.batchId);
      const course = courseById.get(c.courseId);
      return `${studentById.get(c.studentId)?.fullName ?? ""} ${course?.name ?? ""} ${batch?.code ?? ""} ${batch?.name ?? ""} ${c.certificateCode}`
        .toLowerCase()
        .includes(q);
    });
  const filtered = base
    .filter((c) => !status || c.status === status)
    .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime());
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const years = [...new Set(certificates.map((c) => yearOf(c.issuedAt)))].sort().reverse();

  let studentOptions: { id: string; fullName: string; studentNumber: string; phone: string | null }[] = [];
  let batchOptions: CertificateBatchOption[] = [];
  if (result.canManage) {
    const [studentPicker, batchPicker] = await Promise.all([
      searchStudents(context, { status: "active" }, { pageSize: STUDENTS_MAX_PAGE_SIZE }),
      listBatches(context),
    ]);
    studentOptions = studentPicker.ok
      ? studentPicker.data.rows.map((row) => ({ id: row.id, fullName: row.fullName, studentNumber: row.studentNumber, phone: row.phone }))
      : [];
    const pickerBatches = batchPicker.ok ? batchPicker.batches : [];
    // Each batch's courses (same academy, batches from the scoped list).
    const pickerCourses =
      pickerBatches.length && batchPicker.ok
        ? await db
            .select({ batchId: batchCourses.batchId, id: courses.id, name: courses.name })
            .from(batchCourses)
            .innerJoin(courses, eq(courses.id, batchCourses.courseId))
            .where(and(eq(batchCourses.academyId, pickerBatches[0].academyId), inArray(batchCourses.batchId, pickerBatches.map((b) => b.id))))
        : [];
    batchOptions = pickerBatches.map((b) => ({
      id: b.id,
      label: `${b.code} · ${b.name}`,
      courses: pickerCourses
        .filter((c) => c.batchId === b.id)
        .map((c) => ({ id: c.id, name: c.name }))
        .sort((x, y) => x.name.localeCompare(y.name)),
    }));
  }

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Certificates"
        description="Verify a certificate by its code, or browse issued certificates. Cancelling is permanent and a cancelled certificate still verifies as cancelled."
        actions={result.canManage ? <IssueCertificateButton studentOptions={studentOptions} batchOptions={batchOptions} /> : null}
      />

      <VerifyCertificateCard />

      <div className="mb-4">
        <ChipParamFilter
          param="status"
          label="Filter by status"
          options={[
            { value: "", label: "All", count: base.length },
            { value: "issued", label: "Issued", count: base.filter((c) => c.status === "issued").length },
            { value: "cancelled", label: "Cancelled", count: base.filter((c) => c.status === "cancelled").length },
          ]}
        />
      </div>
      <FilterBar>
        <SearchField placeholder="Search student, course, batch or code" />
        <FilterDropdown
          param="year"
          label="Year"
          icon="calendar"
          options={[
            { value: "", label: "All years", count: certificates.length },
            ...years.map((y) => ({ value: y, label: y, count: certificates.filter((c) => yearOf(c.issuedAt) === y).length })),
          ]}
        />
        <FilterDropdown
          param="batch"
          label="Batch"
          icon="layers"
          options={[
            { value: "", label: "All batches", count: certificates.length },
            ...batchIds.map((id) => ({
              value: id,
              label: batchById.get(id)?.code ?? "Batch",
              count: certificates.filter((c) => c.batchId === id).length,
            })),
          ]}
        />
        <ClearFilters params={["q", "status", "year", "batch"]} />
      </FilterBar>

      {rows.length === 0 ? (
        <Section className="mb-8">
          <EmptyState
            message={
              certificates.length
                ? "No certificates match these filters. Try another year or batch."
                : result.canManage
                  ? "No certificates issued yet. Issue one once a student has a published, passing result."
                  : "No certificates issued yet."
            }
            icon={<Icon name="workspace_premium" />}
          />
        </Section>
      ) : (
        <DataTable
          stackBelow={900}
          footer={<PaginationNav page={page} pageSize={PAGE_SIZE} totalCount={filtered.length} searchParams={params} />}
        >
          <thead>
            <tr>
              <th className={rtTh}>Student</th>
              <th className={rtTh}>Course</th>
              <th className={rtTh}>Batch</th>
              <th className={rtTh}>Code</th>
              <th className={rtTh}>Issued</th>
              <th className={rtTh}>Status</th>
              <th className={rtTh}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((certificate) => {
              const student = studentById.get(certificate.studentId);
              const batch = batchById.get(certificate.batchId);
              const issued = certificate.status === "issued";
              return (
                <tr key={certificate.id} className={trHover}>
                  <td className={rtTd} data-label="Student">
                    <PersonCell
                      name={student?.fullName ?? "Student"}
                      sub={student?.studentNumber}
                      href={`/academy/students/${certificate.studentId}`}
                      photoUrl={photos.get(certificate.studentId) ?? null}
                    />
                  </td>
                  <td className={rtTd} data-label="Course">
                    {courseById.get(certificate.courseId) ? (
                      <>
                        <span className="font-semibold">{courseById.get(certificate.courseId)?.name}</span>
                        <span className="block text-xs text-muted">{courseById.get(certificate.courseId)?.programName}</span>
                      </>
                    ) : (
                      <span className="text-muted">Not recorded</span>
                    )}
                  </td>
                  <td className={rtTd} data-label="Batch">
                    <span className="font-semibold">{batch?.code ?? "Batch"}</span>
                    {batch && <span className="block text-xs text-muted">{batch.name}</span>}
                  </td>
                  <td className={`${rtTd} whitespace-nowrap font-mono text-[13px]`} data-label="Code">
                    {certificate.certificateCode}
                  </td>
                  <td className={`${rtTd} whitespace-nowrap`} data-label="Issued">
                    {formatDate(certificate.issuedAt)}
                  </td>
                  <td className={rtTd} data-label="Status">
                    <Badge label={issued ? "Issued" : "Cancelled"} tone={issued ? "green" : "slate"} />
                    {!issued && certificate.cancellationReason && (
                      <span className="mt-1 block max-w-[24ch] text-xs text-muted [overflow-wrap:anywhere]">{certificate.cancellationReason}</span>
                    )}
                  </td>
                  <td className={`${rtTd} text-right`} data-actions="">
                    <span className="inline-flex flex-wrap items-center justify-end gap-2">
                      {issued ? (
                        <>
                          <Link href={`/academy/certificates/${certificate.id}/print`} className={ROW_BTN}>
                            <Icon name="workspace_premium" width={16} height={16} />
                            View
                          </Link>
                          <a href={`/academy/certificates/${certificate.id}/pdf`} download className={ROW_BTN}>
                            PDF
                          </a>
                          {result.canManage && (
                            <CancelCertificateButton
                              certificateId={certificate.id}
                              code={certificate.certificateCode}
                              studentName={student?.fullName ?? "Student"}
                            />
                          )}
                        </>
                      ) : (
                        <span className="text-[13px] text-muted">Unavailable</span>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      <NoteBlock>
        A certificate is issued once per student and completed course, so a batch with several courses can give a student
        several certificates. Each needs a published, passing result in that course. Cancelling needs a reason and cannot
        be undone; the code then verifies as cancelled.
      </NoteBlock>
    </div>
  );
}
