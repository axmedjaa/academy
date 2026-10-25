"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import {
  createCourse,
  requestCourseImageUploadUrlAction,
  updateCourse,
  type CourseFormState,
} from "@/lib/academies/courses-actions";
import type { CourseWithInstructor } from "@/lib/academies/courses";
import type { ProgramRecord } from "@/lib/academies/programs";
import { showSuccessToast } from "@/lib/ui/toast";
import { MAX_RASTER_IMAGE_SIZE_BYTES, RASTER_IMAGE_ACCEPT_ATTRIBUTE, isRasterImageContentType } from "@/lib/storage/upload-policy";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";
import { guardAction } from "@/lib/ui/guard-action";

// Failed requests come back as form errors (see lib/ui/guard-action.ts).
const guardedCreateCourse = guardAction(createCourse);
const guardedUpdateCourse = guardAction(updateCourse);

/**
 * New course / Edit course (design A07 form `course`): Program, Name*,
 * Code, Course length in weeks (with the design's quick picks) and Course
 * picture, followed by the application's own optional Instructor, Start and
 * End dates and Description, so nothing the course record supports is lost.
 * The server validates again (end on or after start, plan course allowance).
 */

const initialState: CourseFormState = { ok: false };

export interface InstructorOption {
  id: string;
  fullName: string;
}

const WEEK_PICKS = [4, 8, 12, 16, 24];

const RULES: DesignFormRule[] = [
  { name: "programId", label: "Program", required: true, kind: "select" },
  { name: "name", label: "Name", required: true },
  {
    name: "durationWeeks",
    label: "Course length in weeks",
    check: (value) => (value && !/^\d+$/.test(value.trim()) ? "Enter whole weeks, for example 8." : null),
  },
  {
    name: "endDate",
    label: "End date",
    check: (value, data) => {
      const start = String(data.get("startDate") ?? "");
      return value && start && value < start ? "The end date can't be before the start date." : null;
    },
  },
];

const SERVER_FIELD_PATTERNS: [RegExp, string][] = [
  [/program/i, "programId"],
  [/end date|before the start/i, "endDate"],
  [/start date/i, "startDate"],
  [/duration|weeks/i, "durationWeeks"],
  [/code/i, "code"],
  [/name/i, "name"],
  [/image/i, "imageRef"],
];

export function uploadCourseImageFile(url: string, file: File): Promise<void> {
  return fetch(url, { method: "PUT", headers: { "Content-Type": file.type }, body: file }).then((response) => {
    if (!response.ok) throw new Error(`The image upload was rejected by storage (HTTP ${response.status}).`);
  });
}

/** Validates, then uploads a chosen course picture; resolves to its storage key. */
export async function uploadCourseImage(file: File): Promise<{ key: string } | { error: string }> {
  if (!isRasterImageContentType(file.type)) return { error: "Choose a JPEG, PNG, WebP or AVIF image." };
  if (file.size > MAX_RASTER_IMAGE_SIZE_BYTES) return { error: "Choose an image of 10 MB or less." };
  const requested = await requestCourseImageUploadUrlAction({ contentType: file.type, fileSizeBytes: file.size });
  if (!requested.ok || !requested.uploadUrl || !requested.key) {
    return { error: requested.error?.message ?? "The upload could not start. Try again." };
  }
  try {
    await uploadCourseImageFile(requested.uploadUrl, file);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The image upload failed." };
  }
  return { key: requested.key };
}

/** The design's file control: 56px dashed preview, Choose image, hint. */
function CoursePictureField({
  currentUrl,
  onUploadingChange,
  error,
}: {
  currentUrl: string | null;
  onUploadingChange: (uploading: boolean) => void;
  error?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [key, setKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(currentUrl);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    onUploadingChange(true);
    const result = await uploadCourseImage(file);
    setUploading(false);
    onUploadingChange(false);
    if ("error" in result) {
      setUploadError(result.error);
      return;
    }
    setKey(result.key);
    setPreview(URL.createObjectURL(file));
  }

  const message = uploadError ?? error;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-dashed border-border-strong bg-[#FAFBFC] text-xs font-normal text-muted">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- local preview or signed storage URL
            <img src={preview} alt="Course picture preview" className="h-full w-full object-cover" />
          ) : (
            "None"
          )}
        </span>
        <button
          type="button"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          className="inline-flex h-11 items-center rounded-lg border border-brand bg-surface px-4 text-[15px] font-semibold text-brand transition-colors duration-150 hover:bg-brand-tint disabled:opacity-60"
        >
          {uploading ? "Uploading…" : preview ? "Change image" : "Choose image"}
        </button>
        <span className="text-[13px] font-normal text-muted">JPEG, PNG, WebP or AVIF, up to 10 MB</span>
        <input ref={inputRef} type="file" accept={RASTER_IMAGE_ACCEPT_ATTRIBUTE} className="hidden" onChange={choose} />
      </div>
      {/* An edit without a new picture keeps the stored one. */}
      {key && <input type="hidden" name="imageRef" value={key} />}
      {message && (
        <span role="alert" className="text-xs font-medium text-[#B91C1C]">
          {message}
        </span>
      )}
    </div>
  );
}

function CourseFields({
  course,
  programs,
  instructors,
  onCancel,
  onSaved,
}: {
  course: CourseWithInstructor | null;
  programs: ProgramRecord[];
  instructors: InstructorOption[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionState(course ? guardedUpdateCourse : guardedCreateCourse, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(RULES);
  const [uploading, setUploading] = useState(false);
  const weeksRef = useRef<HTMLInputElement>(null);
  const activePrograms = programs.filter((program) => program.status === "active" || program.id === course?.programId);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast(course ? "Course updated." : "Course created.");
      onSaved();
    } else if (state.error) {
      showServerError(state.error.message, SERVER_FIELD_PATTERNS);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => {
        // Keep the stored picture on edit unless a new one was uploaded.
        if (course && !data.get("imageRef")) data.set("imageRef", course.imageRef ?? "");
        startTransition(() => formAction(data));
      })}
    >
      {course && <input type="hidden" name="courseId" value={course.id} />}
      <DialogBody>
        <FieldGrid fill>
          <DField label="Program" name="programId" required error={errors.programId}>
            <select
              name="programId"
              defaultValue={course?.programId ?? activePrograms[0]?.id ?? ""}
              onBlur={blur("programId")}
              className={controlClass(Boolean(errors.programId))}
              {...invalidProps("programId", errors.programId)}
            >
              {activePrograms.length === 0 && <option value="">Create a program first</option>}
              {activePrograms.map((program) => (
                <option key={program.id} value={program.id}>
                  {program.name}
                </option>
              ))}
            </select>
          </DField>
          <DField label="Name" name="name" required error={errors.name} full>
            <input
              type="text"
              name="name"
              defaultValue={course?.name ?? ""}
              maxLength={200}
              onBlur={blur("name")}
              className={controlClass(Boolean(errors.name))}
              {...invalidProps("name", errors.name)}
            />
          </DField>
          <DField label="Code" name="code" error={errors.code}>
            <input
              type="text"
              name="code"
              defaultValue={course?.code ?? ""}
              maxLength={50}
              className={controlClass(Boolean(errors.code))}
              {...invalidProps("code", errors.code)}
            />
          </DField>
          <DField label="Course length in weeks" name="durationWeeks" error={errors.durationWeeks}>
            <input
              ref={weeksRef}
              type="number"
              name="durationWeeks"
              min={0}
              step={1}
              inputMode="numeric"
              placeholder="e.g. 8"
              defaultValue={course?.durationWeeks ?? ""}
              onBlur={blur("durationWeeks")}
              className={controlClass(Boolean(errors.durationWeeks))}
              {...invalidProps("durationWeeks", errors.durationWeeks)}
            />
            <span className="mt-1 flex flex-wrap gap-2">
              {WEEK_PICKS.map((weeks) => (
                <button
                  key={weeks}
                  type="button"
                  onClick={() => {
                    if (weeksRef.current) weeksRef.current.value = String(weeks);
                    blur("durationWeeks")();
                  }}
                  className="inline-flex min-h-9 items-center rounded-full border border-brand bg-surface px-3 text-[13px] font-medium text-brand transition-colors duration-150 hover:bg-brand-tint"
                >
                  {weeks} weeks
                </button>
              ))}
            </span>
          </DField>
          <DField label="Course picture (optional)" name="imageRef" error={undefined} full>
            <CoursePictureField currentUrl={course?.imageUrl ?? null} onUploadingChange={setUploading} error={errors.imageRef} />
          </DField>
          <DField label="Instructor (optional)" name="instructorId">
            <select name="instructorId" defaultValue={course?.instructorId ?? ""} className={controlClass(false)}>
              <option value="">Not assigned</option>
              {instructors.map((instructor) => (
                <option key={instructor.id} value={instructor.id}>
                  {instructor.fullName}
                </option>
              ))}
            </select>
          </DField>
          <DField label="Start date (optional)" name="startDate" error={errors.startDate}>
            <input
              type="date"
              name="startDate"
              defaultValue={course?.startDate ?? ""}
              onBlur={blur("endDate")}
              className={controlClass(Boolean(errors.startDate))}
              {...invalidProps("startDate", errors.startDate)}
            />
          </DField>
          <DField label="End date (optional)" name="endDate" error={errors.endDate}>
            <input
              type="date"
              name="endDate"
              defaultValue={course?.endDate ?? ""}
              onBlur={blur("endDate")}
              className={controlClass(Boolean(errors.endDate))}
              {...invalidProps("endDate", errors.endDate)}
            />
          </DField>
          <DField label="Description (optional)" name="description" full>
            <textarea
              name="description"
              rows={3}
              maxLength={2000}
              defaultValue={course?.description ?? ""}
              className={`${controlClass(false, true)} min-h-[88px] resize-y`}
            />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={onCancel}
        submitLabel={course ? "Save changes" : "Create"}
        pendingLabel={course ? "Saving…" : "Creating…"}
        pending={pending}
        disabled={uploading || activePrograms.length === 0}
      />
    </form>
  );
}

export function CourseFormDialog({
  open,
  onOpenChange,
  course,
  programs,
  instructors,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  course: CourseWithInstructor | null;
  programs: ProgramRecord[];
  instructors: InstructorOption[];
  onSaved?: () => void;
}) {
  return (
    <DesignDialog
      open={open}
      onOpenChange={onOpenChange}
      title={course ? "Edit course" : "New course"}
      description={course ? `Batches and students already on ${course.name} keep it.` : undefined}
    >
      {open && (
        <CourseFields
          key={course?.id ?? "new"}
          course={course}
          programs={programs}
          instructors={instructors}
          onCancel={() => onOpenChange(false)}
          onSaved={() => {
            onOpenChange(false);
            onSaved?.();
          }}
        />
      )}
    </DesignDialog>
  );
}
