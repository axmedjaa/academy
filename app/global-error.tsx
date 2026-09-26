"use client";

import "./globals.css";

/**
 * The root error boundary — Next.js's last resort, catching anything that
 * escapes every nested error.tsx (including app/academy/error.tsx), or an
 * error in the root layout itself. Deliberately self-contained (inline
 * styles, no Tailwind classes, no shared UI components) rather than
 * reusing app/academy/_shell/ui.tsx: this is the fallback for when
 * something is broken badly enough to reach here, so it must not depend on
 * anything that could itself be part of what's broken. Next.js requires
 * this file to render its own `<html>`/`<body>` — it fully replaces the
 * root layout rather than nesting inside it.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "1rem",
            padding: "2rem",
            textAlign: "center",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, color: "#111827" }}>Something went wrong</h1>
          <p style={{ fontSize: "0.9rem", color: "#6B7280", maxWidth: 420 }}>
            An unexpected error occurred. Please try again.
          </p>
          {error.digest && <p style={{ fontSize: "0.75rem", color: "#6B7280" }}>Reference: {error.digest}</p>}
          <button
            type="button"
            onClick={() => reset()}
            style={{
              backgroundColor: "#2F5FE0",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "0.6rem 1.2rem",
              fontSize: "0.9rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
