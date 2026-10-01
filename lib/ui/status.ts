/**
 * Phase 1 foundation piece — a single source of truth mapping every status
 * string used anywhere in the app to one of the six badge tones already
 * established by app/academy/_shell/ui.tsx's `Badge`/`StatusBadge`
 * (gray/amber/green/red/blue/slate). Before this file, the same status
 * vocabulary ("approved", "paid", "cancelled", ...) was re-mapped to a tone
 * independently in several files (e.g. dashboard/page.tsx's
 * PAYMENT_STATUS_TONE vs finance-charges-payments.tsx's own copy) — a real
 * risk of the same status meaning a different color on different pages.
 *
 * This is additive: no existing call site is required to use it yet (every
 * page that already passes its own explicit `tone` prop to `Badge` keeps
 * working exactly as before). It exists so a *new* page, or a page revisited
 * in a later phase, has one correct answer to import instead of inventing
 * another local copy.
 */

export type StatusTone = "gray" | "amber" | "green" | "red" | "blue" | "slate";

const STATUS_TONE_MAP: Record<string, StatusTone> = {
  // Lifecycle
  active: "green",
  inactive: "gray",
  archived: "gray",
  draft: "gray",
  suspended: "amber",
  closed: "gray",

  // Approval / workflow
  pending: "amber",
  pending_approval: "amber",
  approved: "green",
  rejected: "red",
  cancelled: "red",
  reversed: "slate",
  completed: "green",
  issued: "green",
  withdrawn: "gray",
  posted: "green",

  // Payments / finance
  open: "gray",
  partially_paid: "amber",
  paid: "green",
  unpaid: "amber",
  overdue: "red",

  // Book stock (lib/academies/books.ts's getStockStatus)
  out_of_stock: "red",
  low_stock: "amber",
  in_stock: "green",
};

/** Falls back to "gray" for any status string not in the map above — a
 * neutral, non-alarming default rather than guessing at a more specific
 * tone for a status this file doesn't yet know about. */
export function getStatusTone(status: string): StatusTone {
  return STATUS_TONE_MAP[status] ?? "gray";
}
