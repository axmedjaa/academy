import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import {
  getAcademyById,
  getAcademySubscriptionOverview,
  getAcademyUsageOverview,
  listAcademyPaymentHistory,
} from "@/lib/academies/approve";
import { getOnboardingChecklistStatus } from "@/lib/academies/onboarding-checklist";
import type { SubscriptionStatus } from "@/lib/subscriptions/state-machine";
import { ApproveAcademyButton } from "./approve-academy-button";
import { OnboardingChecklist } from "./onboarding-checklist";
import { LifecycleActions } from "./lifecycle-actions";

// Same gating as app/platform/academies/page.tsx — see that file's comment
// for why "approveAcademy" (ungrantable, platform_owner-only) is the
// capability used to gate the whole page, not just the Approve action.
const ACADEMIES_CAPABILITY = "approveAcademy";

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ marginBottom: "0.5rem" }}>
      <strong>{label}: </strong>
      <span>{value ?? "—"}</span>
    </div>
  );
}

function formatMoney(amountCents: number, currency: string): string {
  return `${(amountCents / 100).toFixed(2)} ${currency}`;
}

// Matches lib/subscriptions/usage.ts's maxStorageBytes reasoning (bytes can
// legitimately run into the billions) — a plain byte count isn't readable at
// that scale, so this formats it the way any usage dashboard would.
function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

// DESIGN.md §11.1's Subscription Lifecycle badge table — same derived
// display convention as app/platform/academies/page.tsx's statusLabel/
// statusColor for the academy-level (approval) badge, applied here to the
// separate subscription-level badge instead. Duplicated rather than shared
// across the two page files, matching this codebase's existing convention
// of small presentational helpers living next to the page that uses them
// (see that file's own statusLabel/statusColor).
function subscriptionStatusLabel(status: SubscriptionStatus): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "trial":
      return "Trial";
    case "active":
      return "Active";
    case "past_due":
      return "Past Due — grace period";
    case "suspended":
      return "Suspended";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

function subscriptionStatusColor(status: SubscriptionStatus): string {
  switch (status) {
    case "active":
      return "#0a7d2c";
    case "trial":
      return "#2563eb";
    case "draft":
      return "#6b7280";
    case "past_due":
      return "#b45309";
    case "suspended":
    case "expired":
    case "cancelled":
      return "#b91c1c";
    default:
      return "#6b7280";
  }
}

export default async function AcademyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, ACADEMIES_CAPABILITY);

  if (!allowed) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Access denied</h1>
        <p>You don&apos;t have permission to view this page.</p>
      </main>
    );
  }

  const { id } = await params;
  const academy = await getAcademyById(id);

  if (!academy) {
    return (
      <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1>Academy not found</h1>
        <p>
          <Link href="/platform/academies">Back to academies</Link>
        </p>
      </main>
    );
  }

  // Independent reads, none depending on another's result — fetched
  // together rather than sequentially awaited.
  const [checklist, subscription, usageOverview, payments] = await Promise.all([
    getOnboardingChecklistStatus(academy.id),
    getAcademySubscriptionOverview(academy.id),
    getAcademyUsageOverview(academy.id),
    listAcademyPaymentHistory(academy.id),
  ]);

  const checklistUnmetReasons = checklist
    ? checklist.items.filter((item) => !item.satisfied).map((item) => item.detail)
    : ["Onboarding checklist could not be loaded."];

  return (
    <main
      style={{
        maxWidth: 800,
        margin: "2rem auto",
        fontFamily: "system-ui, sans-serif",
        padding: "0 1rem",
      }}
    >
      <p>
        <Link href="/platform/academies">Back to academies</Link>
      </p>
      <h1>{academy.name}</h1>

      <section style={{ marginBottom: "2rem" }}>
        <h2>Profile</h2>
        <Field label="Slug" value={academy.slug} />
        <Field label="Type" value={academy.type} />
        <Field label="Default currency" value={academy.defaultCurrency} />
        <Field label="Address" value={academy.address} />
        <Field label="Phone" value={academy.phone} />
        <Field label="Email" value={academy.email} />
        <Field label="Website" value={academy.website} />
        <Field label="Registration number" value={academy.registrationNumber} />
        <Field label="Primary contact" value={academy.primaryContactName} />
        <Field label="Primary contact phone" value={academy.primaryContactPhone} />
      </section>

      <section style={{ marginBottom: "2rem" }}>
        <h2>Onboarding metadata</h2>
        <Field
          label="Created by"
          value={academy.createdByEmail ?? academy.createdBy}
        />
        <Field label="Created" value={academy.createdAt.toLocaleString()} />
        <Field
          label="Approved by"
          value={academy.approvedByEmail ?? academy.approvedBy}
        />
        <Field
          label="Approved"
          value={academy.approvedAt ? academy.approvedAt.toLocaleString() : null}
        />
      </section>

      <section style={{ marginBottom: "2rem" }}>
        <h2>Approval</h2>
        {academy.status === "approved" ? (
          <p style={{ color: "#0a7d2c" }}>
            Approved on {academy.approvedAt?.toLocaleString()}
            {academy.approvedByEmail ? ` by ${academy.approvedByEmail}` : ""}.
          </p>
        ) : academy.status === "closed" ? (
          <p style={{ color: "#6b7280" }}>This academy is closed.</p>
        ) : (
          <ApproveAcademyButton academyId={academy.id} />
        )}
      </section>

      {/*
        DESIGN.md §11.3's onboarding-checklist widget. Rendered whenever the
        academy exists (getOnboardingChecklistStatus only returns null for a
        missing/malformed id, which can't be true here — academy was already
        fetched above) — never faked, and never silently omitted just
        because the academy hasn't been approved yet, since "approved" is
        itself one of the checklist's own rows.
      */}
      {checklist && <OnboardingChecklist status={checklist} />}

      <section style={{ marginBottom: "2rem" }}>
        <h2>Lifecycle actions</h2>
        <LifecycleActions
          academyId={academy.id}
          subscriptionStatus={subscription?.status ?? null}
          checklistSatisfied={checklist?.allSatisfied ?? false}
          checklistUnmetReasons={checklistUnmetReasons}
          academyClosed={academy.status === "closed"}
        />
      </section>

      {/*
        Read-only Subscription & Plan section (task brief: "your Subscription
        tab is read-only display only" — no Renew button here, see
        lifecycle-actions.tsx's own comment for why Renew belongs to
        /platform/subscriptions instead).
      */}
      <section style={{ marginBottom: "2rem" }}>
        <h2>Subscription &amp; plan</h2>
        {subscription ? (
          <>
            <Field label="Plan" value={subscription.planName} />
            <Field
              label="Price"
              value={formatMoney(subscription.priceAmountCents, subscription.currency)}
            />
            <Field label="Billing period" value={subscription.billingPeriod} />
            <div style={{ marginBottom: "0.5rem" }}>
              <strong>Status: </strong>
              <span
                style={{
                  color: subscriptionStatusColor(subscription.effectiveStatus),
                  fontWeight: 600,
                }}
              >
                {subscriptionStatusLabel(subscription.effectiveStatus)}
              </span>
              {subscription.effectiveStatus !== subscription.status && (
                <span style={{ color: "#6b7280", fontSize: "0.85rem" }}>
                  {" "}
                  (stored as &quot;{subscription.status}&quot; — not yet lazily flipped)
                </span>
              )}
            </div>
            <Field label="Starts" value={subscription.startsAt.toLocaleString()} />
            <Field
              label="Ends"
              value={subscription.endsAt ? subscription.endsAt.toLocaleString() : null}
            />
            <Field
              label="Trial ends"
              value={subscription.trialEndsAt ? subscription.trialEndsAt.toLocaleString() : null}
            />
            <Field
              label="Activated"
              value={subscription.activatedAt ? subscription.activatedAt.toLocaleString() : null}
            />
            <Field
              label="Suspended"
              value={subscription.suspendedAt ? subscription.suspendedAt.toLocaleString() : null}
            />
            <Field
              label="Cancelled"
              value={subscription.cancelledAt ? subscription.cancelledAt.toLocaleString() : null}
            />
            <Field
              label="Renewed"
              value={subscription.renewedAt ? subscription.renewedAt.toLocaleString() : null}
            />
            <Field label="Notes" value={subscription.notes} />
          </>
        ) : (
          <p>No subscription has been created for this academy yet.</p>
        )}
      </section>

      {/* Read-only Usage vs. Allowances section. */}
      <section style={{ marginBottom: "2rem" }}>
        <h2>Usage vs. allowances</h2>
        {usageOverview.usage ? (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Resource</th>
                <th style={{ textAlign: "left" }}>Current</th>
                <th style={{ textAlign: "left" }}>Limit</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Branches", usageOverview.usage.branchCount, usageOverview.limits?.maxBranches],
                  [
                    "Students",
                    usageOverview.usage.activeStudentsCount,
                    usageOverview.limits?.maxStudents,
                  ],
                  ["Staff", usageOverview.usage.activeStaffCount, usageOverview.limits?.maxStaff],
                  ["Courses", usageOverview.usage.courseCount, usageOverview.limits?.maxCourses],
                ] as const
              ).map(([label, current, limit]) => {
                const overLimit = typeof limit === "number" && current > limit;
                return (
                  <tr key={label}>
                    <td>{label}</td>
                    <td style={{ color: overLimit ? "#b91c1c" : undefined, fontWeight: overLimit ? 600 : undefined }}>
                      {current}
                    </td>
                    <td>{typeof limit === "number" ? limit : "—"}</td>
                  </tr>
                );
              })}
              <tr>
                <td>Storage</td>
                <td>{formatBytes(usageOverview.usage.storageUsedBytes)}</td>
                <td>
                  {usageOverview.limits ? formatBytes(usageOverview.limits.maxStorageBytes) : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p>
            No usage snapshot yet — recalculateUsage hasn&apos;t run for this academy (see{" "}
            <Link href="/platform/usage">/platform/usage</Link>).
          </p>
        )}
        <p style={{ color: "#6b7280", fontSize: "0.85rem", marginTop: "0.5rem" }}>
          Informational only — over-limit rows are visually flagged, but enforcement happens at
          creation time (checkAllowance), not here.
        </p>
      </section>

      {/* Read-only Payment History section. */}
      <section>
        <h2>Payment history</h2>
        {payments.length === 0 ? (
          <p>No subscription payments have been recorded for this academy yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Received</th>
                <th style={{ textAlign: "left" }}>Amount</th>
                <th style={{ textAlign: "left" }}>Method</th>
                <th style={{ textAlign: "left" }}>Status</th>
                <th style={{ textAlign: "left" }}>Recorded by</th>
                <th style={{ textAlign: "left" }}>Verified by</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td>{payment.receivedAt.toLocaleDateString()}</td>
                  <td>{formatMoney(payment.amountCents, payment.currency)}</td>
                  <td>{payment.paymentMethod}</td>
                  <td>{payment.status}</td>
                  <td>{payment.recordedByEmail ?? "—"}</td>
                  <td>{payment.verifiedByEmail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
