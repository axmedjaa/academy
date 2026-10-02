"use client";

import { useRef, useState } from "react";
import {
  confirmStudentPhotoUploadAction,
  removeStudentPhotoAction,
  requestStudentPhotoUploadUrlAction,
} from "@/lib/academies/students-actions";
import { requestNewStudentPhotoUploadUrlAction } from "@/lib/academies/register-student-actions";
import { ConfirmButton, type ConfirmActionResult } from "@/app/academy/_shell/confirm-dialog";
import { Button, ErrorMessage } from "@/app/academy/_shell/ui";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_SIZE_LABEL = "5 MB";

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
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploadedKey, setUploadedKey] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  function resetSelection() {
    setSelectedFile(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setError(null);
    setStatus("idle");
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      setError("Photo must be JPEG, PNG, or WebP.");
      resetSelection();
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError(`Photo must be ${MAX_SIZE_LABEL} or smaller.`);
      resetSelection();
      return;
    }

    setSelectedFile(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
  }

  async function handleUpload() {
    if (!selectedFile) return;
    setError(null);
    setStatus("uploading");

    const requested =
      props.mode === "new"
        ? await requestNewStudentPhotoUploadUrlAction({ contentType: selectedFile.type, fileSizeBytes: selectedFile.size })
        : await requestStudentPhotoUploadUrlAction(props.studentId, {
            contentType: selectedFile.type,
            fileSizeBytes: selectedFile.size,
          });
    if (!requested.ok) {
      const message = requested.error?.message ?? "The photo could not be uploaded. Please try again.";
      setError(message);
      setStatus("error");
      showErrorToast(message);
      return;
    }

    try {
      await uploadPhotoFile(requested.uploadUrl, selectedFile);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The photo could not be uploaded. Please try again.";
      setError(message);
      setStatus("error");
      showErrorToast(message);
      return;
    }

    if (props.mode === "new") {
      // Nothing to confirm yet — no student row exists. The key is held
      // here and submitted (via the hidden input below) alongside the
      // rest of the registration form; registerStudent does the real
      // verification when the form is actually submitted.
      setUploadedKey(requested.key);
      setStatus("idle");
      resetSelection();
      showSuccessToast("Photo uploaded. It will be attached when you register this student.");
      return;
    }

    setStatus("confirming");
    const confirmed = await confirmStudentPhotoUploadAction(props.studentId, requested.key);
    if (!confirmed.ok) {
      const message = confirmed.error?.message ?? "The photo upload could not be verified.";
      setError(message);
      setStatus("error");
      showErrorToast(message);
      return;
    }

    setStatus("idle");
    resetSelection();
    showSuccessToast("Photo uploaded successfully.");
    props.onChanged();
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

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-app">
        {displayedPreviewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview or a short-lived signed R2 URL, same convention as academy-logo-upload.tsx.
          <img src={displayedPreviewUrl} alt="Student photo preview" className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs text-muted">No photo</span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleFileChange}
          disabled={busy}
          className="text-sm text-ink file:mr-3 file:rounded-control file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:file:bg-app"
        />

        {error && <ErrorMessage message={error} />}
        {status === "uploading" && <p className="text-sm text-muted">Uploading...</p>}
        {status === "confirming" && <p className="text-sm text-muted">Verifying...</p>}
        {props.mode === "new" && uploadedKey && status === "idle" && (
          <p className="text-sm font-medium text-success">Photo ready — will be attached on registration.</p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" disabled={!selectedFile || busy} onClick={handleUpload}>
            {busy ? "Uploading..." : "Upload photo"}
          </Button>
          {props.mode === "edit" && hasCurrentPhoto && (
            <ConfirmButton
              label="Remove photo"
              title="Remove this student's photo?"
              description="This permanently deletes the current photo. This cannot be undone."
              successMessage="Photo removed."
              onConfirm={handleRemove}
              onSuccess={props.onChanged}
            />
          )}
        </div>
      </div>

      {props.mode === "new" && <input type="hidden" name={props.hiddenFieldName} value={uploadedKey ?? ""} />}
    </div>
  );
}
