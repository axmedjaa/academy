"use client";

import { useRef, useState } from "react";
import {
  confirmStudentPhotoUploadAction,
  removeStudentPhotoAction,
  requestStudentPhotoUploadUrlAction,
} from "@/lib/academies/students-actions";
import { requestNewStudentPhotoUploadUrlAction } from "@/lib/academies/register-student-actions";
import { ConfirmButton, type ConfirmActionResult } from "@/app/academy/_shell/confirm-dialog";
import { showSuccessToast } from "@/lib/ui/toast";
import { MAX_RASTER_IMAGE_SIZE_BYTES, RASTER_IMAGE_ACCEPT_ATTRIBUTE, isRasterImageContentType } from "@/lib/storage/upload-policy";

const MAX_SIZE_BYTES = MAX_RASTER_IMAGE_SIZE_BYTES;
const MAX_SIZE_LABEL = "10 MB";

type Status = "idle" | "uploading" | "confirming" | "error";

/** Plain `fetch` PUT, no progress tracking — same shape as
 * books-manager.tsx's own `uploadCoverFile` (this codebase already has
 * two independently-duplicated upload helpers — academy-logo-upload.tsx's
 * fancier XHR-with-progress version, and this simpler one — rather than
 * one shared utility; this is the third, following the simpler of the
 * two since a student photo is a small, quick upload where progress
 * tracking adds little). */
function uploadPhotoFile(url: string, file: File): Promise<void> {
  return fetch(url, { method: "PUT", headers: { "Content-Type": file.type }, body: file }).then((response) => {
    if (!response.ok) {
      throw new Error(`The photo upload was rejected by storage (HTTP ${response.status}).`);
    }
  });
}

type Props =
  | {
      /** No student row exists yet (the registration form) — uploads to
       * an academy-scoped (not student-scoped) key, then hands the
       * already-uploaded, not-yet-persisted key to the parent form via a
       * hidden input, for registerStudent to verify and persist in one
       * step alongside the rest of the new student's fields. */
      mode: "new";
      hiddenFieldName: string;
    }
  | {
      /** An existing student — uploading immediately confirms and
       * persists the photo (its own small action, independent of the
       * surrounding Edit form's own Save button), same "logo upload
       * applies itself" convention as academy-logo-upload.tsx. */
      mode: "edit";
      studentId: string;
      currentPhotoUrl: string | null;
      onChanged: () => void;
    };

export function StudentPhotoField(props: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadedKey, setUploadedKey] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  function resetSelection() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Choosing a file uploads it straight away (design: "Choose image" with
  // no separate upload step). Validation, the signed upload, and — for an
  // existing student — the server-side confirmation are unchanged.
  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setError(null);
    setStatus("idle");
    if (!file) return;

    if (!isRasterImageContentType(file.type)) {
      setError("Photo must be JPEG, PNG, WebP, or AVIF.");
      resetSelection();
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError(`Photo must be ${MAX_SIZE_LABEL} or smaller.`);
      resetSelection();
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const localPreview = URL.createObjectURL(file);
    setPreviewUrl(localPreview);
    await upload(file);
  }

  async function upload(file: File) {
    setError(null);
    setStatus("uploading");

    const requested =
      props.mode === "new"
        ? await requestNewStudentPhotoUploadUrlAction({ contentType: file.type, fileSizeBytes: file.size })
        : await requestStudentPhotoUploadUrlAction(props.studentId, {
            contentType: file.type,
            fileSizeBytes: file.size,
          });
    if (!requested.ok) {
      const message = requested.error?.message ?? "The photo could not be uploaded. Please try again.";
      setError(message);
      setStatus("error");
      resetSelection();
      return;
    }

    try {
      await uploadPhotoFile(requested.uploadUrl, file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The photo could not be uploaded. Please try again.");
      setStatus("error");
      resetSelection();
      return;
    }

    if (props.mode === "new") {
      // No student row exists yet; the key is submitted with the form and
      // registerStudent verifies it.
      setUploadedKey(requested.key);
      setStatus("idle");
      return;
    }

    setStatus("confirming");
    const confirmed = await confirmStudentPhotoUploadAction(props.studentId, requested.key);
    if (!confirmed.ok) {
      setError(confirmed.error?.message ?? "The photo upload could not be verified.");
      setStatus("error");
      resetSelection();
      return;
    }

    setStatus("idle");
    resetSelection();
    showSuccessToast("Photo updated.");
    props.onChanged();
  }

  function clearNewPhoto() {
    setUploadedKey(null);
    resetSelection();
  }

  async function handleRemove(): Promise<ConfirmActionResult> {
    if (props.mode !== "edit") return { ok: true };
    const result = await removeStudentPhotoAction(props.studentId);
    if (!result.ok) {
      return { ok: false, error: { message: result.error?.message ?? "Failed to remove the photo." } };
    }
    return { ok: true };
  }

  const displayedPreviewUrl = previewUrl ?? (props.mode === "edit" ? props.currentPhotoUrl : null);
  const hasCurrentPhoto = props.mode === "edit" && Boolean(props.currentPhotoUrl) && !previewUrl;
  const busy = status === "uploading" || status === "confirming";
  const hasNewPhoto = props.mode === "new" && (Boolean(uploadedKey) || Boolean(previewUrl));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-dashed border-border-strong bg-[#FAFBFC] text-[11px] font-medium text-muted">
          {displayedPreviewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview or a short-lived signed R2 URL.
            <img src={displayedPreviewUrl} alt="Preview" className="h-full w-full object-cover" />
          ) : (
            "None"
          )}
        </div>
        <label
          className={`relative inline-flex min-h-11 cursor-pointer items-center justify-center rounded-lg border border-brand px-4 text-sm font-semibold text-brand transition-colors duration-150 hover:bg-brand-tint ${busy ? "pointer-events-none opacity-60" : ""}`}
        >
          {busy ? (status === "confirming" ? "Verifying…" : "Uploading…") : displayedPreviewUrl ? "Change image" : "Choose image"}
          <input
            ref={fileInputRef}
            type="file"
            accept={RASTER_IMAGE_ACCEPT_ATTRIBUTE}
            onChange={handleFileChange}
            disabled={busy}
            className="absolute h-px w-px opacity-0"
          />
        </label>
        {hasNewPhoto && !busy && (
          <button
            type="button"
            onClick={clearNewPhoto}
            className="min-h-11 rounded-lg border border-border-strong bg-surface px-3.5 text-sm font-medium text-ink hover:bg-app"
          >
            Remove
          </button>
        )}
        {props.mode === "edit" && hasCurrentPhoto && !busy && (
          <ConfirmButton
            label="Remove"
            title="Remove this student's photo?"
            description="This permanently deletes the current photo. This cannot be undone."
            successMessage="Photo removed."
            onConfirm={handleRemove}
            onSuccess={props.onChanged}
          />
        )}
        <span className="text-xs font-normal text-muted">JPEG, PNG, WebP or AVIF, up to {MAX_SIZE_LABEL}</span>
      </div>
      {error && (
        <span role="alert" className="text-xs font-medium text-[#B91C1C]">
          {error}
        </span>
      )}
      {props.mode === "new" && <input type="hidden" name={props.hiddenFieldName} value={uploadedKey ?? ""} />}
    </div>
  );
}
