"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  confirmAcademyLogoUploadAction,
  removeAcademyLogoAction,
  requestAcademyLogoUploadUrlAction,
} from "@/lib/academies/academy-logo-actions";
import { ConfirmButton, type ConfirmActionResult } from "@/app/academy/_shell/confirm-dialog";
import { Button, ErrorMessage, Section } from "@/app/academy/_shell/ui";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_SIZE_LABEL = "5 MB";

interface Props {
  /** A short-lived signed GET URL for the academy's current logo (see
   * page.tsx's own comment) — never the raw object key, never stored,
   * always freshly generated per render. `null` when no logo is set. */
  currentLogoUrl: string | null;
}

type Status = "idle" | "uploading" | "confirming" | "success" | "error";

/**
 * Uploads a file directly to Cloudflare R2 via the presigned PUT URL — the
 * binary never passes through a Server Action (task's explicit "do not
 * send the actual binary through a Server Action" rule). Plain
 * `XMLHttpRequest`, not `fetch`, specifically for `xhr.upload.onprogress` —
 * `fetch` has no upload-progress event.
 *
 * A CORS-blocked cross-origin PUT (the R2 bucket has no CORS policy
 * allowing this app's origin) surfaces to JS as `xhr.status === 0` with no
 * response body at all — browsers deliberately withhold the real reason
 * from scripts for any CORS failure, so that specific case is called out
 * by name here rather than left as an opaque "Upload failed" (still no
 * secret/internal detail is exposed — CORS status is not sensitive). Any
 * other failure logs its real HTTP status/response body to the browser
 * console (visible in DevTools) for diagnosis, while the error thrown back
 * to the caller stays a plain, non-technical message for the on-screen UI.
 */
function uploadFileWithProgress(url: string, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      console.error("Logo upload to storage failed", { status: xhr.status, response: xhr.responseText });
      reject(new Error(`The logo upload was rejected by storage (HTTP ${xhr.status}). Please try again.`));
    };
    xhr.onerror = () => {
      if (xhr.status === 0) {
        console.error(
          "Logo upload blocked before any HTTP response was received — this usually means the storage bucket's CORS policy doesn't allow this app's origin.",
        );
        reject(
          new Error(
            "The upload was blocked by the browser. This usually means the storage bucket isn't configured to allow uploads from this site yet.",
          ),
        );
        return;
      }
      console.error("Logo upload network error", { status: xhr.status });
      reject(new Error("The logo upload failed due to a network error. Please try again."));
    };
    xhr.send(file);
  });
}

/**
 * DESIGN.md §9.11 "Academy Profile" names a logo field; this replaces what
 * used to be a plain "Logo reference" text input (paste-a-URL) with a real
 * upload — see lib/academies/academy-logo.ts's own module comment for why
 * that text field had to come out of the general profile form entirely,
 * not just visually.
 *
 * Never shows the R2 bucket name, object key, Cloudflare account id, or
 * the presigned URL itself — only a preview image and plain-language
 * status text, per this task's explicit UI requirement.
 */
export function AcademyLogoUpload({ currentLogoUrl }: Props) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState(0);
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
      setError("Logo must be JPEG, PNG, or WebP.");
      resetSelection();
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError(`Logo must be ${MAX_SIZE_LABEL} or smaller.`);
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
    setProgress(0);

    const requested = await requestAcademyLogoUploadUrlAction({
      contentType: selectedFile.type,
      fileSizeBytes: selectedFile.size,
    });
    if (!requested.ok || !requested.uploadUrl || !requested.key) {
      const message = requested.error?.message ?? "The logo could not be uploaded. Please try again.";
      setError(message);
      setStatus("error");
      showErrorToast(message);
      return;
    }

    try {
      await uploadFileWithProgress(requested.uploadUrl, selectedFile, setProgress);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The logo could not be uploaded. Please try again.";
      setError(message);
      setStatus("error");
      showErrorToast(message);
      return;
    }

    setStatus("confirming");
    const confirmed = await confirmAcademyLogoUploadAction(requested.key);
    if (!confirmed.ok) {
      const message = confirmed.error?.message ?? "The logo upload could not be verified.";
      setError(message);
      setStatus("error");
      showErrorToast(message);
      return;
    }

    setStatus("success");
    resetSelection();
    showSuccessToast("Logo uploaded successfully.");
    router.refresh();
  }

  async function handleRemove(): Promise<ConfirmActionResult> {
    const result = await removeAcademyLogoAction();
    if (!result.ok) {
      return { ok: false, error: { message: result.error?.message ?? "Failed to remove the logo." } };
    }
    return { ok: true };
  }

  return (
    <Section>
      <h2 className="text-base font-semibold text-ink">Academy logo</h2>
      <p className="mt-1 text-sm text-muted">
        Upload your academy logo. PNG, JPG, or WebP. Maximum {MAX_SIZE_LABEL}.
      </p>

      <div className="mt-4 flex flex-wrap items-start gap-4">
        <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-control border border-border bg-app">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview URL, not an optimizable remote image.
            <img src={previewUrl} alt="Selected logo preview" className="h-full w-full object-contain" />
          ) : currentLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 URL, same convention as every other *Ref field render in this codebase.
            <img src={currentLogoUrl} alt="Current academy logo" className="h-full w-full object-contain" />
          ) : (
            <span className="text-xs text-muted">No logo</span>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleFileChange}
            disabled={status === "uploading" || status === "confirming"}
            className="text-sm text-ink file:mr-3 file:rounded-control file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-ink hover:file:bg-app"
          />

          {error && <ErrorMessage message={error} />}
          {(status === "uploading" || status === "confirming") && (
            <p className="text-sm text-muted">{status === "uploading" ? `Uploading... ${progress}%` : "Verifying..."}</p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={!selectedFile || status === "uploading" || status === "confirming"}
              onClick={handleUpload}
            >
              {status === "uploading" || status === "confirming" ? "Uploading..." : "Upload logo"}
            </Button>
            {currentLogoUrl && (
              <ConfirmButton
                label="Remove logo"
                title="Remove academy logo?"
                description="This permanently deletes the current logo. This cannot be undone."
                successMessage="Logo removed successfully."
                onConfirm={handleRemove}
                onSuccess={() => router.refresh()}
              />
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}
