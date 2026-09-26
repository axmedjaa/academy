"use client";

import { useEffect } from "react";
import { Button, LinkButton } from "@/app/academy/_shell/ui";

/**
 * Next.js error boundary for the entire `/academy/*` subtree — until now
 * there was no error.tsx anywhere in the app, so any unhandled exception on
 * any academy page fell through to Next's own generic default error screen.
 * This renders INSIDE the existing `/academy/*` shell (the layout keeps
 * rendering above/around this boundary, same as any other nested
 * error.tsx), so the sidebar/header stay visible and this only replaces
 * the broken page's own content.
 *
 * `reset()` re-renders the segment that threw without a full page reload —
 * the right first move for a transient failure (a flaky query, a dropped
 * connection). "Go to dashboard" is the fallback for anything reset()
 * can't fix. Never shows the raw error message/stack to the user — the
 * safe, human message is the only thing on screen; the real error is
 * logged to the browser console (`error.digest` is Next's own safe,
 * non-sensitive correlation id for cross-referencing server logs).
 */
export default function AcademyError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Academy page error:", error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col items-center justify-center gap-4 px-4 py-16 text-center">
      <h1 className="text-xl font-bold text-ink">Something went wrong</h1>
      <p className="text-sm text-muted">
        An unexpected error occurred while loading this page. You can try again, or head back to your dashboard.
      </p>
      {error.digest && <p className="text-xs text-muted">Reference: {error.digest}</p>}
      <div className="flex flex-wrap justify-center gap-3">
        <Button type="button" onClick={() => reset()}>
          Try again
        </Button>
        <LinkButton href="/academy/dashboard" variant="secondary">
          Go to dashboard
        </LinkButton>
      </div>
    </div>
  );
}
