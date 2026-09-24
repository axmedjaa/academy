import type { AcademyAccessDenyReason } from "@/lib/academies/access-gate";

// PLAN.md Item 28 / DESIGN.md §3.1 "Permission-denied: a calm full-section
// message... never a raw error page" + §3.1 "No-access
// (subscription/closure): full-page, non-dismissible" (§11.1). One
// component driven by `reason` rather than a dedicated page per reason —
// matches this item's "minimal shell" scope and the same
// heading+paragraph visual style already used by app/protected/page.tsx
// and app/platform/staff/page.tsx's "Access denied" state.
//
// `not_authenticated` is deliberately excluded from the reason union here:
// per the assignment brief, that result redirects to /login instead of
// rendering inline, so app/academy/layout.tsx never constructs this
// component for that reason.
export type AcademyBlockedMessageReason = Exclude<AcademyAccessDenyReason, "not_authenticated">;

const HEADINGS: Record<AcademyBlockedMessageReason, string> = {
  not_a_member: "Not a member",
  ambiguous_academy: "Multiple academies",
  closed: "Academy closed",
  no_subscription: "No subscription",
  not_yet_active: "Not yet active",
  suspended: "Access suspended",
  expired: "Subscription expired",
  cancelled: "Subscription cancelled",
};

export function AcademyAccessMessage({
  reason,
  message,
}: {
  reason: AcademyBlockedMessageReason;
  message: string;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-app px-4 py-12">
      <div className="w-full max-w-md rounded-card border border-border bg-surface p-6 text-center shadow-card">
        <h1 className="text-lg font-semibold text-ink">{HEADINGS[reason]}</h1>
        <p className="mt-2 text-sm text-muted">{message}</p>
      </div>
    </main>
  );
}
