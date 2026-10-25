"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteCourse, setCourseStatus } from "@/lib/academies/courses-actions";
import type { CourseDeletionEligibilitySummary, CourseWithInstructor } from "@/lib/academies/courses";
import type { ProgramRecord } from "@/lib/academies/programs";
import { Badge, Button, EmptyState, FormDialog, PageHeader, Section, trHover } from "@/app/academy/_shell/ui";
import { DataTable, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { formatDate } from "@/lib/ui/date";
import { Icon } from "@/app/academy/_shell/icons";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CourseFormDialog, type InstructorOption } from "./course-form";

/**
 * Courses (design A07): header with New course, the Course / Program /
 * Instructor / Starts / Ends / Status table (picture or initials, name
 * linking to the course page), Archive or Restore per row. New and Edit use
 * the design form dialog in course-form.tsx.
 */

interface Props {
  courses: (CourseWithInstructor & { deletionEligibility: CourseDeletionEligibilitySummary })[];
  programs: ProgramRecord[];
  instructors: InstructorOption[];
  canManage: boolean;
}

const ROW_BTN =
  "inline-flex h-10 items-center whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:opacity-50";

function courseInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

function statusTone(status: string): "green" | "gray" {
  return status === "archived" ? "gray" : "green";
}

export function CoursesList({ courses, programs, instructors, canManage }: Props) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Which row's Archive/Restore or Delete confirmation is open — the
  // dropdown menu item opens it externally (ConfirmButton's controlled
  // mode), same pattern as app/academy/students/students-list.tsx.
  const [archiveRowId, setArchiveRowId] = useState<string | null>(null);
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null);
  const [previewImageId, setPreviewImageId] = useState<string | null>(null);

  const editingCourse = courses.find((c) => c.id === editingId) ?? null;
  const previewImageCourse = courses.find((c) => c.id === previewImageId) ?? null;

  function toggleCourseStatus(course: CourseWithInstructor) {
    return setCourseStatus(course.id, course.status === "active" ? "archived" : "active");
  }

  const programNameById = new Map(programs.map((program) => [program.id, program.name]));

  return (
    <section className="flex flex-col">
      <PageHeader
        title="Courses"
        description="Courses belong to a program."
        actions={
          canManage ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              New course
            </Button>
          ) : undefined
        }
      />

      {courses.length === 0 ? (
        <Section>
          <EmptyState message={canManage ? "No courses yet. Create one under a program." : "No courses to show yet."} icon={<Icon name="menu_book" />} />
        </Section>
      ) : (
        <DataTable stackBelow={900}>
          <thead>
            <tr>
              <th className={rtTh}>Course</th>
              <th className={rtTh}>Program</th>
              <th className={rtTh}>Instructor</th>
              <th className={rtTh}>Starts</th>
              <th className={rtTh}>Ends</th>
              <th className={rtTh}>Status</th>
              {canManage && <th className={rtTh}><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {courses.map((course) => (
              <tr key={course.id} className={trHover}>
                <td className={rtTd} data-label="Course">
                  <span className="flex min-w-0 items-center gap-3">
                    {course.imageUrl ? (
                      <button
                        type="button"
                        onClick={() => setPreviewImageId(course.id)}
                        aria-label={`View ${course.name}'s image`}
                        className="h-10 w-10 shrink-0 overflow-hidden rounded-full border-2 border-white shadow-[0_0_0_1px_#E2E5EA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL; this codebase renders images with plain <img> */}
                        <img src={course.imageUrl} alt="" className="h-full w-full object-cover" />
                      </button>
                    ) : (
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-tint text-[13px] font-bold text-brand">
                        {courseInitials(course.name)}
                      </span>
                    )}
                    <Link
                      href={`/academy/courses/${course.id}`}
                      className="flex min-h-11 min-w-0 flex-col justify-center no-underline hover:no-underline"
                    >
                      <span className="font-semibold leading-snug !text-brand [overflow-wrap:anywhere] hover:underline">
                        {course.name}
                      </span>
                      {course.code && <span className="text-xs text-muted">{course.code}</span>}
                    </Link>
                  </span>
                </td>
                <td className={rtTd} data-label="Program">
                  {programNameById.get(course.programId) ?? <span className="text-muted">—</span>}
                </td>
                <td className={rtTd} data-label="Instructor">
                  {course.instructorName ?? <span className="text-muted">Not assigned</span>}
                </td>
                <td className={`${rtTd} tabular-nums`} data-label="Starts">
                  {formatDate(course.startDate)}
                </td>
                <td className={`${rtTd} tabular-nums`} data-label="Ends">
                  {formatDate(course.endDate)}
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge label={course.status} tone={statusTone(course.status)} />
                </td>
                {canManage && (
                  <td className={rtTd} data-actions="">
                    <span className="inline-flex items-center gap-2">
                      <button type="button" onClick={() => setArchiveRowId(course.id)} className={ROW_BTN}>
                        {course.status === "active" ? "Archive" : "Restore"}
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`More actions for ${course.name}`}
                            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-app hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                          >
                            <Icon name="more" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditingId(course.id)}>Edit</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {course.deletionEligibility.eligible ? (
                            <DropdownMenuItem variant="destructive" onClick={() => setDeleteRowId(course.id)}>
                              Delete
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              disabled
                              title={`This course cannot be permanently deleted because ${course.deletionEligibility.reasons.join("; ")}. Use Archive instead.`}
                            >
                              Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </span>

                    <ConfirmButton
                      label={course.status === "active" ? "Archive" : "Restore"}
                      variant={course.status === "active" ? "danger" : "success"}
                      icon={course.status === "active" ? "archive" : "autorenew"}
                      open={archiveRowId === course.id}
                      onOpenChange={(nextOpen) => setArchiveRowId(nextOpen ? course.id : null)}
                      title={course.status === "active" ? `Archive "${course.name}"?` : `Restore "${course.name}"?`}
                      description={
                        course.status === "active" ? (
                          <>
                            Archived courses are hidden from new batch creation and free up this academy&apos;s plan
                            course allowance, but every batch and student history is kept and can be restored at any
                            time.
                          </>
                        ) : (
                          <>This course will be marked active again and count against this academy&apos;s plan course allowance.</>
                        )
                      }
                      successMessage={course.status === "active" ? "Course archived." : "Course restored."}
                      onConfirm={() => toggleCourseStatus(course)}
                    />
                    {course.deletionEligibility.eligible && (
                      <ConfirmButton
                        label="Delete"
                        variant="dangerSolid"
                        open={deleteRowId === course.id}
                        onOpenChange={(nextOpen) => setDeleteRowId(nextOpen ? course.id : null)}
                        title={`Delete "${course.name}" permanently?`}
                        description={<>This cannot be undone.</>}
                        confirmInput={{ label: `Type "${course.name}" to confirm`, requiredValue: course.name }}
                        successMessage="Course deleted."
                        onConfirm={() => deleteCourse(course.id, course.name)}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {previewImageCourse && (
        <FormDialog
          open={previewImageId !== null}
          onOpenChange={(nextOpen) => !nextOpen && setPreviewImageId(null)}
          title={`${previewImageCourse.name}'s image`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- signed storage URL; this codebase renders images with plain <img> */}
          <img
            src={previewImageCourse.imageUrl ?? ""}
            alt={`${previewImageCourse.name} course image`}
            className="max-h-[70vh] w-full rounded-md object-contain"
          />
          <div className="mt-4 flex justify-end">
            <Button type="button" variant="secondary" onClick={() => setPreviewImageId(null)}>
              Close
            </Button>
          </div>
        </FormDialog>
      )}

      {canManage && (
        <>
          <CourseFormDialog
            open={createOpen}
            onOpenChange={setCreateOpen}
            course={null}
            programs={programs}
            instructors={instructors}
            onSaved={() => router.refresh()}
          />
          <CourseFormDialog
            open={editingCourse !== null}
            onOpenChange={(next) => !next && setEditingId(null)}
            course={editingCourse}
            programs={programs}
            instructors={instructors}
            onSaved={() => router.refresh()}
          />
        </>
      )}
    </section>
  );
}
