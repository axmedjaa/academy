"use client";

import { useState } from "react";

/** First + last initial, e.g. "Jane Doe" -> "JD" — same avatar-style
 * identity cue as app/academy/staff/staff-table.tsx's row identity cell, for
 * a consistent "people list" visual language across the app. Purely
 * cosmetic; the actual identity is still `fullName`/`studentNumber`. */
export function getInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/**
 * The shared student identity thumbnail — used anywhere a student's row
 * shows an avatar (Students List, Admissions, Results, Exams marks entry,
 * the Student detail page's header). Previously each of those pages had
 * its own hand-rolled `getInitials` + avatar `<span>` copy that never
 * showed the real photo even after lib/academies/students.ts gained real
 * R2-backed `profileImageRef` support — this consolidates them into one
 * component so a photo added in one place is visible everywhere a student
 * is shown, not just the Students List.
 *
 * `photoUrl` is a short-lived SIGNED R2 GET url, already resolved
 * server-side from the student's `profileImageRef` object key (see each
 * page's own `getStudentPhotoUrl` call — never resolved here, since that
 * needs server-side R2 credentials). Shown as a round thumbnail when
 * present and loadable; falls back to the existing initials circle —
 * never a broken-image icon — when there's no photo, or the signed URL
 * has since expired/failed to load (e.g. the page was left open past the
 * URL's ~15 minute lifetime).
 *
 * `onPreview` is optional: when provided, the thumbnail becomes a real,
 * keyboard-reachable `<button>` that opens a larger preview (Students
 * List's own pattern). Pages that don't want a preview dialog simply omit
 * it — the thumbnail still shows the real photo, just as a plain,
 * non-interactive image, same as the initials fallback already was.
 */
export function StudentAvatar({
  fullName,
  photoUrl,
  onPreview,
  sizeClassName = "h-9 w-9",
  textClassName = "text-xs",
}: {
  fullName: string;
  photoUrl: string | null;
  onPreview?: () => void;
  sizeClassName?: string;
  textClassName?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = Boolean(photoUrl) && !imageFailed;

  if (!showImage) {
    return (
      <span
        className={`flex ${sizeClassName} shrink-0 items-center justify-center rounded-full bg-brand-tint ${textClassName} font-semibold text-brand`}
      >
        {getInitials(fullName)}
      </span>
    );
  }

  const image = (
    // eslint-disable-next-line @next/next/no-img-element -- this codebase renders every student/course/id-card image via a plain <img> (see courses-list.tsx, id-card-visual.tsx), no next/image usage anywhere
    <img
      src={photoUrl ?? undefined}
      alt={`${fullName}'s profile photo`}
      className={`${sizeClassName} rounded-full object-cover`}
      onError={() => setImageFailed(true)}
    />
  );

  if (!onPreview) {
    return <span className={`block ${sizeClassName} shrink-0 overflow-hidden rounded-full`}>{image}</span>;
  }

  return (
    <button
      type="button"
      onClick={onPreview}
      aria-label={`View ${fullName}'s photo`}
      className={`block ${sizeClassName} shrink-0 overflow-hidden rounded-full transition-opacity duration-150 hover:opacity-90 motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40`}
    >
      {image}
    </button>
  );
}
