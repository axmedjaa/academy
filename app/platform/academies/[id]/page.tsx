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
import { getAcademyDeletionEligibility } from "@/lib/academies/delete-academy";
import type { SubscriptionStatus } from "@/lib/subscriptions/state-machine";
import { ApproveAcademyButton } from "./approve-academy-button";
import { OnboardingChecklist } from "./onboarding-checklist";
import { LifecycleActions } from "./lifecycle-actions";
import { DeleteAcademySection } from "./delete-academy-section";
import { Badge, PAGE_WRAP, PageMessage, Section, TableWrap, td, th, trHover } from "@/app/academy/_shell/ui";

// Same gating as app/platform/academies/page.tsx — see that file's comment
// for why "approveAcademy" (ungrantable, platform_owner-only) is the
// capability used to gate the whole page, not just the Approve action.
const ACADEMIES_CAPABILITY = "approveAcademy";

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="text-sm text-ink">{value ?? "—"}</dd>
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
// statusTone for the academy-level (approval) badge, applied here to the
// separate subscription-level badge instead. Duplicated rather than shared
// across the two page files, matching this codebase's existing convention
// of small presentational helpers living next to the page that uses them
// (see that file's own statusLabel/statusTone).
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

function subscriptionStatusTone(status: SubscriptionStatus): "green" | "blue" | "gray" | "amber" | "red" {
  switch (status) {
    case "active":
      return "green";
    case "trial":
      return "blue";
    case "draft":
      return "gray";
    case "past_due":
      return "amber";
    case "suspended":
    case "expired":
    case "cancelled":
      return "red";
    default:
      return "gray";
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
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  const { id } = await params;
  const academy = await getAcademyById(id);

  if (!academy) {
    return (
      <div className={PAGE_WRAP}>
        <Section>
          <h1 className="text-lg font-semibold text-ink">Academy not found</h1>
          <Link href="/platform/academies" className="mt-2 inline-block text-sm text-brand hover:underline">
            Back to academies
          </Link>
        </Section>
      </div>
    );
  }

  // Independent reads, none depending on another's result — fetched
  // together rather than sequentially awaited.
  const [checklist, subscription, usageOverview, payments, deletionEligibility] = await Promise.all([
    getOnboardingChecklistStatus(academy.id),
    getAcademySubscriptionOverview(academy.id),
    getAcademyUsageOverview(academy.id),
    listAcademyPaymentHistory(academy.id),
    getAcademyDeletionEligibility(context, academy.id),
  ]);

  const checklistUnmetReasons = checklist
    ? checklist.items.filter((item) => !item.satisfied).map((item) => item.detail)
    : ["Onboarding checklist could not be loaded."];

  return (
    <div className={PAGE_WRAP}>
      <Link href="/platform/academies" className="mb-4 inline-block text-sm text-brand hover:underline">
        ← Back to academies
      </Link>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-ink sm:text-2xl">{academy.name}</h1>
        {academy.status === "approved" && <Badge label="Approved" tone="green" />}
        {academy.status === "closed" && <Badge label="Closed" tone="gray" />}
        {academy.status === "pending_approval" && <Badge label="Pending approval" tone="amber" />}
      </div>

      <div className="flex flex-col gap-6">
        <Section>
          <h2 className="mb-2 text-base font-semibold text-ink">Profile</h2>
          <dl className="divide-y divide-border">
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
          </dl>
        </Section>

        <Section>
          <h2 className="mb-2 text-base font-semibold text-ink">Onboarding metadata</h2>
          <dl className="divide-y divide-border">
            <Field label="Created by" value={academy.createdByEmail ?? academy.createdBy} />
            <Field label="Created" value={academy.createdAt.toLocaleString()} />
            <Field label="Approved by" value={academy.approvedByEmail ?? academy.approvedBy} />
            <Field label="Approved" value={academy.approvedAt ? academy.approvedAt.toLocaleString() : null} />
          </dl>
        </Section>

        <Section>
          <h2 className="mb-2 text-base font-semibold text-ink">Approval</h2>
          {academy.status === "approved" ? (
            <p className="text-sm font-medium text-success">
              Approved on {academy.approvedAt?.toLocaleString()}
              {academy.approvedByEmail ? ` by ${academy.approvedByEmail}` : ""}.
            </p>
          ) : academy.status === "closed" ? (
            <p className="text-sm text-muted">This academy is closed.</p>
          ) : (
            <ApproveAcademyButton academyId={academy.id} />
          )}
        </Section>

        {/*
          DESIGN.md §11.3's onboarding-checklist widget. Rendered whenever the
          academy exists (getOnboardingChecklistStatus only returns null for a
          missing/malformed id, which can't be true here — academy was already
          fetched above) — never faked, and never silently omitted just
          because the academy hasn't been approved yet, since "approved" is
          itself one of the checklist's own rows.
        */}
        {checklist && <OnboardingChecklist status={checklist} />}

        <Section>
          <h2 className="mb-3 text-base font-semibold text-ink">Lifecycle actions</h2>
          <LifecycleActions
            academyId={academy.id}
            subscriptionStatus={subscription?.status ?? null}
            checklistSatisfied={checklist?.allSatisfied ?? false}
            checklistUnmetReasons={checklistUnmetReasons}
            academyClosed={academy.status === "closed"}
          />
        </Section>

        {/*
          Read-only Subscription & Plan section (task brief: "your Subscription
          tab is read-only display only" — no Renew button here, see
          lifecycle-actions.tsx's own comment for why Renew belongs to
          /platform/subscriptions instead).
        */}
        <Section>
          <h2 className="mb-2 text-base font-semibold text-ink">Subscription &amp; plan</h2>
          {subscription ? (
            <>
              <dl className="divide-y divide-border">
                <Field label="Plan" value={subscription.planName} />
                <Field label="Price" value={formatMoney(subscription.priceAmountCents, subscription.currency)} />
                <Field label="Billing period" value={subscription.billingPeriod} />
              </dl>
              <div className="flex items-center gap-2 py-2">
                <span className="text-xs font-medium text-muted">Status</span>
                <Badge label={subscriptionStatusLabel(subscription.effectiveStatus)} tone={subscriptionStatusTone(subscription.effectiveStatus)} />
                {subscription.effectiveStatus !== subscription.status && (
                  <span className="text-xs text-muted">(stored as &quot;{subscription.status}&quot; — not yet lazily flipped)</span>
                )}
              </div>
              <dl className="divide-y divide-border">
                <Field label="Starts" value={subscription.startsAt.toLocaleString()} />
                <Field label="Ends" value={subscription.endsAt ? subscription.endsAt.toLocaleString() : null} />
                <Field label="Trial ends" value={subscription.trialEndsAt ? subscription.trialEndsAt.toLocaleString() : null} />
                <Field label="Activated" value={subscription.activatedAt ? subscription.activatedAt.toLocaleString() : null} />
                <Field label="Suspended" value={subscription.suspendedAt ? subscription.suspendedAt.toLocaleString() : null} />
                <Field label="Cancelled" value={subscription.cancelledAt ? subscription.cancelledAt.toLocaleString() : null} />
                <Field label="Renewed" value={subscription.renewedAt ? subscription.renewedAt.toLocaleString() : null} />
                <Field label="Notes" value={subscription.notes} />
              </dl>
            </>
          ) : (
            <p className="text-sm text-muted">No subscription has been created for this academy yet.</p>
          )}
        </Section>

        {/* Read-only Usage vs. Allowances section. */}
        <Section>
          <h2 className="mb-3 text-base font-semibold text-ink">Usage vs. allowances</h2>
          {usageOverview.usage ? (
            <TableWrap>
              <thead>
                <tr>
                  <th className={th}>Resource</th>
                  <th className={th}>Current</th>
                  <th className={th}>Limit</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Branches", usageOverview.usage.branchCount, usageOverview.limits?.maxBranches],
                    ["Students", usageOverview.usage.activeStudentsCount, usageOverview.limits?.maxStudents],
                    ["Staff", usageOverview.usage.activeStaffCount, usageOverview.limits?.maxStaff],
                    ["Courses", usageOverview.usage.courseCount, usageOverview.limits?.maxCourses],
                  ] as const
                ).map(([label, current, limit]) => {
                  const overLimit = typeof limit === "number" && current > limit;
                  return (
                    <tr key={label} className={trHover}>
                      <td className={td}>{label}</td>
                      <td className={`${td} ${overLimit ? "font-semibold text-danger" : ""}`}>{current}</td>
                      <td className={td}>{typeof limit === "number" ? limit : "—"}</td>
                    </tr>
                  );
                })}
                <tr className={trHover}>
                  <td className={td}>Storage</td>
                  <td className={td}>{formatBytes(usageOverview.usage.storageUsedBytes)}</td>
                  <td className={td}>{usageOverview.limits ? formatBytes(usageOverview.limits.maxStorageBytes) : "—"}</td>
                </tr>
              </tbody>
            </TableWrap>
          ) : (
            <p className="text-sm text-muted">
              No usage snapshot yet — recalculateUsage hasn&apos;t run for this academy (see{" "}
              <Link href="/platform/usage" className="text-brand hover:underline">
                /platform/usage
              </Link>
              ).
            </p>
          )}
          <p className="mt-2 text-xs text-muted">
            Informational only — over-limit rows are visually flagged, but enforcement happens at creation time
            (checkAllowance), not here.
          </p>
        </Section>

        {/* Read-only Payment History section. */}
        <Section>
          <h2 className="mb-3 text-base font-semibold text-ink">Payment history</h2>
          {payments.length === 0 ? (
            <p className="text-sm text-muted">No subscription payments have been recorded for this academy yet.</p>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <th className={th}>Received</th>
                  <th className={th}>Amount</th>
                  <th className={th}>Method</th>
                  <th className={th}>Status</th>
                  <th className={th}>Recorded by</th>
                  <th className={th}>Verified by</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id} className={trHover}>
                    <td className={td}>{payment.receivedAt.toLocaleDateString()}</td>
                    <td className={td}>{formatMoney(payment.amountCents, payment.currency)}</td>
                    <td className={td}>{payment.paymentMethod}</td>
                    <td className={td}>{payment.status}</td>
                    <td className={td}>{payment.recordedByEmail ?? "—"}</td>
                    <td className={td}>{payment.verifiedByEmail ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Section>

        {/*
          Permanent deletion — platform_owner only (Platform Owner Academy
          Deletion / Offboarding feature). Deliberately its own bordered,
          danger-toned section, visually separate from "Lifecycle actions"
          above: closing is routine and reversible-in-spirit (data stays
          forever); this is the one truly irreversible action on this page.
        */}
        <Section className="border-danger/30">
          <h2 className="mb-1 text-base font-semibold text-danger">Danger zone</h2>
          <p className="mb-3 text-sm text-muted">Permanently remove this academy from the platform.</p>
          {deletionEligibility.ok ? (
            <DeleteAcademySection eligibility={deletionEligibility.eligibility} />
          ) : (
            <p className="text-sm text-muted">{deletionEligibility.error.message}</p>
          )}
        </Section>
      </div>
    </div>
  );
}
