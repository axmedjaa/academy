"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateCourse } from "@/lib/academies/courses-actions";
import type { CourseWithInstructor } from "@/lib/academies/courses";
import type { ProgramRecord } from "@/lib/academies/programs";
import { RASTER_IMAGE_ACCEPT_ATTRIBUTE } from "@/lib/storage/upload-policy";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Icon } from "@/app/academy/_shell/icons";
import { CourseFormDialog, uploadCourseImage, type InstructorOption } from "../course-form";

/** Header action: Edit course, in the same dialog the list uses. */
export function EditCourseButton({
  course,
  programs,
  instructors,
}: {
  course: CourseWithInstructor;
  programs: ProgramRecord[];
  instructors: InstructorOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-11 items-center rounded-lg border border-border-strong bg-surface px-[18px] text-[15px] font-semibold text-ink transition-colors duration-150 hover:bg-app"
      >
        Edit course
      </button>
      <CourseFormDialog
        open={open}
        onOpenChange={setOpen}
        course={course}
        programs={programs}
        instructors={instructors}
        onSaved={() => router.refresh()}
      />
    </>
  );
}

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/**
 * Design `img` block "Course picture": the picture (or initials), a line on
 * where it is shown, and Upload image for managers. Saving goes through the
 * existing `updateCourse` action with the course's current values, so only
 * the picture changes.
 */
export function CoursePictureCard({ course, canManage }: { course: CourseWithInstructor; canManage: boolean }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    const uploaded = await uploadCourseImage(file);
    if ("error" in uploaded) {
      setBusy(false);
      showErrorToast(uploaded.error);
      return;
    }
    const data = new FormData();
    data.set("courseId", course.id);
    data.set("programId", course.programId);
    data.set("name", course.name);
    data.set("code", course.code ?? "");
    data.set("description", course.description ?? "");
    data.set("durationWeeks", course.durationWeeks === null ? "" : String(course.durationWeeks));
    data.set("startDate", course.startDate ?? "");
    data.set("endDate", course.endDate ?? "");
    data.set("instructorId", course.instructorId ?? "");
    data.set("imageRef", uploaded.key);
    const result = await updateCourse({ ok: false }, data);
    setBusy(false);
    if (!result.ok) {
      showErrorToast(result.error?.message ?? "The picture could not be saved.");
      return;
    }
    showSuccessToast("Course picture updated.");
    startTransition(() => router.refresh());
  }

  return (
    <section className="mb-8 flex flex-wrap items-center gap-5 rounded-card border border-border bg-surface p-5 shadow-card">
      <span className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl border-4 border-white bg-brand-tint text-[28px] font-bold text-brand shadow-[0_0_0_1px_#E2E5EA,0_2px_6px_rgba(17,24,39,0.08)]">
        {course.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed storage URL; this codebase renders images with plain <img>
          <img src={course.imageUrl} alt={`${course.name} course picture`} className="h-full w-full object-cover" />
        ) : (
          initialsOf(course.name)
        )}
      </span>
      <div className="min-w-0 flex-[1_1_220px]">
        <h2 className="text-base font-semibold text-ink">Course picture</h2>
        <p className="mt-1 text-[13px] text-muted">Shown on the course list. JPEG, PNG, WebP or AVIF, up to 10 MB.</p>
      </div>
      {canManage && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="inline-flex h-11 items-center gap-2 rounded-lg bg-brand px-4 text-[15px] font-semibold text-white transition-colors duration-150 hover:bg-brand-hover disabled:opacity-60"
          >
            <Icon name="upload" width={18} height={18} />
            {busy ? "Uploading…" : course.imageUrl ? "Replace image" : "Upload image"}
          </button>
          <input ref={inputRef} type="file" accept={RASTER_IMAGE_ACCEPT_ATTRIBUTE} className="hidden" onChange={choose} />
        </>
      )}
    </section>
  );
}
