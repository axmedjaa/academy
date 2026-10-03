"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  createCourse,
  deleteCourse,
  requestCourseImageUploadUrlAction,
  setCourseStatus,
  updateCourse,
  type CourseFormState,
} from "@/lib/academies/courses-actions";
import type { CourseDeletionEligibilitySummary, CourseWithInstructor } from "@/lib/academies/courses";
import type { ProgramRecord } from "@/lib/academies/programs";
import {
  Badge,
  Button,
  EmptyState,
  ErrorMessage,
  Field,
  FormDialog,
  Section,
  TableWrap,
  inputClass,
  td,
  th,
  trHover,
} from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const initialState: CourseFormState = { ok: false };

const ALLOWED_COURSE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_COURSE_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

interface InstructorOption {
  id: string;
  fullName: string;
}

interface Props {
  courses: (CourseWithInstructor & { deletionEligibility: CourseDeletionEligibilitySummary })[];
  programs: ProgramRecord[];
  instructors: InstructorOption[];
  canManage: boolean;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function statusTone(status: string): "green" | "gray" {
  return status === "archived" ? "gray" : "green";
}

function uploadCourseImageFile(url: string, file: File): Promise<void> {
  return fetch(url, { method: "PUT", headers: { "Content-Type": file.type }, body: file }).then((response) => {
    if (!response.ok) throw new Error(`The image upload was rejected by storage (HTTP ${response.status}).`);
  });
}

export function CoursesList({ courses, programs, instructors, canManage }: Props) {
  const [createState, createFormAction, creating] = useActionState(createCourse, initialState);
  const [updateState, updateFormAction, updating] = useActionState(updateCourse, initialState);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Which row's Archive/Restore or Delete confirmation is open — the
  // dropdown menu item opens it externally (ConfirmButton's controlled
  // mode), same pattern as app/academy/students/students-list.tsx.
  const [archiveRowId, setArchiveRowId] = useState<string | null>(null);
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null);
  const [previewImageId, setPreviewImageId] = useState<string | null>(null);

  // New course's image is uploaded to R2 as soon as a file is chosen (same
  // "upload before the row exists" convention as books-manager.tsx's new
  // book cover), then carried into the create form as a hidden field —
  // unlike a book cover this is optional, so there's nothing gating
  // "Create course" on it.
  const newImageInputRef = useRef<HTMLInputElement>(null);
  const [newImageKey, setNewImageKey] = useState<string | null>(null);
  const [newImagePreviewUrl, setNewImagePreviewUrl] = useState<string | null>(null);
  const [newImageUploading, setNewImageUploading] = useState(false);
  const [newImageError, setNewImageError] = useState<string | null>(null);

  const editingCourse = courses.find((c) => c.id === editingId) ?? null;
  const previewImageCourse = courses.find((c) => c.id === previewImageId) ?? null;

  // Auto-close the edit dialog once its own update succeeds — see
  // branches-list.tsx's identical pattern/comment.
  const [prevUpdateOk, setPrevUpdateOk] = useState(updateState.ok);
  if (updateState.ok !== prevUpdateOk) {
    setPrevUpdateOk(updateState.ok);
    if (updateState.ok) setEditingId(null);
  }

  // Reset the new-course image picker once creation succeeds — React 19's
  // action-bound form already resets every other (uncontrolled) field
  // natively, but this hidden field's value is controlled by this
  // component's own state, so it needs the same explicit reset.
  const [prevCreateOk, setPrevCreateOk] = useState(createState.ok);
  if (createState.ok !== prevCreateOk) {
    setPrevCreateOk(createState.ok);
    if (createState.ok) {
      setNewImageKey(null);
      setNewImagePreviewUrl(null);
      setNewImageError(null);
    }
  }

  // Clearing the native file input's value (so the same file can be chosen
  // again later) is a DOM-ref side effect, not a render-time state
  // adjustment — it has to happen in an effect, not inline above.
  useEffect(() => {
    if (newImageKey === null && newImageInputRef.current) {
      newImageInputRef.current.value = "";
    }
  }, [newImageKey]);

  async function handleNewImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setNewImageError(null);
    if (!ALLOWED_COURSE_IMAGE_TYPES.includes(file.type)) {
      setNewImageError("Image must be JPEG, PNG, or WebP.");
      return;
    }
    if (file.size > MAX_COURSE_IMAGE_SIZE_BYTES) {
      setNewImageError("Image must be 5 MB or smaller.");
      return;
    }
    setNewImageUploading(true);
    setNewImageKey(null);
    const requested = await requestCourseImageUploadUrlAction({ contentType: file.type, fileSizeBytes: file.size });
    if (!requested.ok || !requested.uploadUrl || !requested.key) {
      setNewImageUploading(false);
      setNewImageError(requested.error?.message ?? "Failed to start image upload.");
      return;
    }
    try {
      await uploadCourseImageFile(requested.uploadUrl, file);
    } catch (err) {
      setNewImageUploading(false);
      setNewImageError(err instanceof Error ? err.message : "Image upload failed.");
      return;
    }
    setNewImageUploading(false);
    setNewImageKey(requested.key);
    setNewImagePreviewUrl(URL.createObjectURL(file));
  }

  function toggleCourseStatus(course: CourseWithInstructor) {
    return setCourseStatus(course.id, course.status === "active" ? "archived" : "active");
  }

  return (
    <section className="flex flex-col gap-6">
      {courses.length === 0 ? (
        <Section>
          <EmptyState message="No courses to show yet." icon={<Icon name="menu_book" />} />
        </Section>
      ) : (
      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Image</th>
            <th className={th}>Name</th>
            <th className={th}>Instructor</th>
            <th className={th}>Starts</th>
            <th className={th}>Ends</th>
            <th className={th}>Status</th>
            {canManage && <th className={th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
            {courses.map((course) => (
              <tr key={course.id} className={trHover}>
                <td className={td}>
                  {course.imageUrl ? (
                    <button
                      type="button"
                      onClick={() => setPreviewImageId(course.id)}
                      aria-label={`View ${course.name}'s image`}
                      className="block h-12 w-12 overflow-hidden rounded-md transition-opacity duration-150 hover:opacity-90 motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element -- this codebase renders every course/academy image via a plain <img> (see app/academy/id-cards/id-card-visual.tsx), no next/image usage anywhere */}
                      <img
                        src={course.imageUrl}
                        alt={`${course.name} course thumbnail`}
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className={td}>
                  <Link href={`/academy/courses/${course.id}`} className="font-medium text-brand hover:underline">
                    {course.name}
                  </Link>
                  {course.code && <span className="text-muted"> ({course.code})</span>}
                </td>
                <td className={td}>{course.instructorName ?? "—"}</td>
                <td className={td}>{formatDate(course.startDate)}</td>
                <td className={td}>{formatDate(course.endDate)}</td>
                <td className={td}>
                  <Badge label={course.status} tone={statusTone(course.status)} />
                </td>
                {canManage && (
                  <td className={td}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Actions for ${course.name}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-app hover:text-ink motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                        >
                          <Icon name="more" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setEditingId(course.id)}>Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setArchiveRowId(course.id)}>
                          {course.status === "active" ? "Archive" : "Restore"}
                        </DropdownMenuItem>
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

                    <ConfirmButton
                      label={course.status === "active" ? "Archive" : "Restore"}
                      variant={course.status === "active" ? "danger" : "secondary"}
                      open={archiveRowId === course.id}
                      onOpenChange={(nextOpen) => setArchiveRowId(nextOpen ? course.id : null)}
                      title={course.status === "active" ? `Archive "${course.name}"?` : `Restore "${course.name}"?`}
                      description={
                        course.status === "active" ? (
                          <>
                            Archived courses are hidden from new batch creation and free up this
                            academy&apos;s plan course allowance, but every batch and student history is
                            kept and can be restored at any time.
                          </>
                        ) : (
                          <>
                            This course will be marked active again and count against this academy&apos;s
                            plan course allowance.
                          </>
                        )
                      }
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
                        onConfirm={() => deleteCourse(course.id, course.name)}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
        </tbody>
      </TableWrap>
      )}

      {previewImageCourse && (
        <FormDialog
          open={previewImageId !== null}
          onOpenChange={(nextOpen) => !nextOpen && setPreviewImageId(null)}
          title={`${previewImageCourse.name}'s image`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- see the thumbnail's own suppression above */}
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

      {canManage && editingCourse && (
        <FormDialog
          open={editingCourse !== null}
          onOpenChange={(nextOpen) => !nextOpen && setEditingId(null)}
          title={`Edit course — ${editingCourse.name}`}
        >
          <EditCourseForm
            key={editingCourse.id}
            course={editingCourse}
            programs={programs}
            instructors={instructors}
            updateFormAction={updateFormAction}
            updateState={updateState}
            updating={updating}
            onCancel={() => setEditingId(null)}
          />
        </FormDialog>
      )}

      {canManage && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Add course</h2>
          <form action={createFormAction} className="mt-4 flex max-w-lg flex-col gap-3">
            <Field label="Program">
              <select name="programId" required className={inputClass}>
                {programs.map((program) => (
                  <option key={program.id} value={program.id}>
                    {program.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Name">
              <input type="text" name="name" required className={inputClass} />
            </Field>
            <Field label="Code">
              <input type="text" name="code" className={inputClass} />
            </Field>
            <Field label="Description">
              <textarea name="description" rows={3} className={inputClass} />
            </Field>
            <Field label="Duration (weeks)">
              <input type="number" name="durationWeeks" min={0} className={inputClass} />
            </Field>
            <Field label="Course image (optional)">
              <div className="flex items-center gap-3">
                <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border border-border bg-surface">
                  {newImagePreviewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local object URL preview, never uploaded anywhere else.
                    <img src={newImagePreviewUrl} alt="Course image preview" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-[10px] text-muted">No image</span>
                  )}
                </div>
                <div>
                  <label className="cursor-pointer text-sm text-brand hover:underline">
                    {newImageUploading ? "Uploading..." : newImageKey ? "Change image" : "Choose image"}
                    <input
                      ref={newImageInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      disabled={newImageUploading}
                      onChange={handleNewImageChange}
                    />
                  </label>
                  <p className="mt-1 text-xs text-muted">JPEG, PNG, or WebP, up to 5 MB.</p>
                  {newImageError && <p className="mt-1 text-xs text-danger">{newImageError}</p>}
                </div>
              </div>
            </Field>
            <input type="hidden" name="imageRef" value={newImageKey ?? ""} />
            <Field label="Instructor">
              <select name="instructorId" defaultValue="" className={inputClass}>
                <option value="">No instructor assigned</option>
                {instructors.map((instructor) => (
                  <option key={instructor.id} value={instructor.id}>
                    {instructor.fullName}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Start date">
                <input type="date" name="startDate" className={inputClass} />
              </Field>
              <Field label="End date">
                <input type="date" name="endDate" className={inputClass} />
              </Field>
            </div>
            {createState.error && <ErrorMessage message={createState.error.message} />}
            {createState.ok && <p className="text-sm font-medium text-success">Course created.</p>}
            <Button type="submit" disabled={creating} className="self-start">
              {creating ? "Creating..." : "Create course"}
            </Button>
          </form>
        </Section>
      )}
    </section>
  );
}

/**
 * Pulled out of CoursesList's inline JSX and keyed by `course.id` where
 * it's rendered — this is what gives the image-upload state (below) a
 * clean reset for free whenever a different row's Edit dialog opens,
 * rather than needing manual "if editingId changed, reset..." bookkeeping.
 */
function EditCourseForm({
  course,
  programs,
  instructors,
  updateFormAction,
  updateState,
  updating,
  onCancel,
}: {
  course: CourseWithInstructor;
  programs: ProgramRecord[];
  instructors: InstructorOption[];
  updateFormAction: (formData: FormData) => void;
  updateState: CourseFormState;
  updating: boolean;
  onCancel: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // `null` until a NEW image is uploaded in this dialog — the hidden
  // `imageRef` field below falls back to the course's existing raw
  // `imageRef` (legacy URL or R2 key, whichever it already is) so an edit
  // that doesn't touch the image leaves it completely unchanged.
  const [imageKey, setImageKey] = useState<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(course.imageUrl);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  async function handleImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setImageError(null);
    if (!ALLOWED_COURSE_IMAGE_TYPES.includes(file.type)) {
      setImageError("Image must be JPEG, PNG, or WebP.");
      return;
    }
    if (file.size > MAX_COURSE_IMAGE_SIZE_BYTES) {
      setImageError("Image must be 5 MB or smaller.");
      return;
    }
    setImageUploading(true);
    setImageKey(null);
    const requested = await requestCourseImageUploadUrlAction({ contentType: file.type, fileSizeBytes: file.size });
    if (!requested.ok || !requested.uploadUrl || !requested.key) {
      setImageUploading(false);
      setImageError(requested.error?.message ?? "Failed to start image upload.");
      return;
    }
    try {
      await uploadCourseImageFile(requested.uploadUrl, file);
    } catch (err) {
      setImageUploading(false);
      setImageError(err instanceof Error ? err.message : "Image upload failed.");
      return;
    }
    setImageUploading(false);
    setImageKey(requested.key);
    setImagePreviewUrl(URL.createObjectURL(file));
  }

  return (
    <form action={updateFormAction} className="flex flex-col gap-3">
      <input type="hidden" name="courseId" value={course.id} />
      <Field label="Program">
        <select name="programId" required defaultValue={course.programId} className={inputClass}>
          {programs.map((program) => (
            <option key={program.id} value={program.id}>
              {program.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Name">
        <input type="text" name="name" required defaultValue={course.name} className={inputClass} />
      </Field>
      <Field label="Code">
        <input type="text" name="code" defaultValue={course.code ?? ""} className={inputClass} />
      </Field>
      <Field label="Description">
        <textarea name="description" defaultValue={course.description ?? ""} rows={3} className={inputClass} />
      </Field>
      <Field label="Duration (weeks)">
        <input type="number" name="durationWeeks" min={0} defaultValue={course.durationWeeks ?? ""} className={inputClass} />
      </Field>
      <Field label="Course image (optional)">
        <div className="flex items-center gap-3">
          <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border border-border bg-surface">
            {imagePreviewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed R2 URL or local object URL preview, same convention as books-manager.tsx.
              <img src={imagePreviewUrl} alt="Course image preview" className="h-full w-full object-cover" />
            ) : (
              <span className="text-[10px] text-muted">No image</span>
            )}
          </div>
          <div>
            <label className="cursor-pointer text-sm text-brand hover:underline">
              {imageUploading ? "Uploading..." : "Change image"}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                disabled={imageUploading}
                onChange={handleImageChange}
              />
            </label>
            <p className="mt-1 text-xs text-muted">JPEG, PNG, or WebP, up to 5 MB.</p>
            {imageError && <p className="mt-1 text-xs text-danger">{imageError}</p>}
          </div>
        </div>
      </Field>
      <input type="hidden" name="imageRef" value={imageKey ?? course.imageRef ?? ""} />
      <Field label="Instructor">
        <select name="instructorId" defaultValue={course.instructorId ?? ""} className={inputClass}>
          <option value="">No instructor assigned</option>
          {instructors.map((instructor) => (
            <option key={instructor.id} value={instructor.id}>
              {instructor.fullName}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Start date">
          <input type="date" name="startDate" defaultValue={course.startDate ?? ""} className={inputClass} />
        </Field>
        <Field label="End date">
          <input type="date" name="endDate" defaultValue={course.endDate ?? ""} className={inputClass} />
        </Field>
      </div>
      {updateState.error && <ErrorMessage message={updateState.error.message} />}
      <div className="mt-2 flex gap-2">
        <Button type="submit" disabled={updating}>
          {updating ? "Saving..." : "Save changes"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
