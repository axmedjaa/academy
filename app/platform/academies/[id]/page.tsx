import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
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
import { formatCalendarDate, formatDate } from "@/lib/ui/date";
import { formatMoney } from "@/lib/ui/money";
import { ApproveAcademyButton } from "./approve-academy-button";
import { OnboardingChecklist } from "./onboarding-checklist";
import { LifecycleActions } from "./lifecycle-actions";
import { DeleteAcademySection } from "./delete-academy-section";
import { BackLink, Badge, PAGE_WRAP, PageMessage, Section } from "@/app/academy/_shell/ui";
import { ChatActions } from "@/app/academy/_shell/chat-actions";
import { approvalLabel, approvalTone, planLabel, subscriptionLabel, subscriptionTone } from "../../_shared/status";
import { UsageBar, formatGb } from "../../_shared/usage-bar";

const ACADEMIES_CAPABILITY = "approveAcademy";
const DAY_MS = 24 * 60 * 60 * 1000;

function requestTime(): number {
  return Date.now();
}

const PAYMENT_TONE = { pending: "amber", verified: "green", rejected: "red", reversed: "slate" } as const;

/** Design detail card: a 15px title (optional aside) over its content. */
function Card({ title, aside, children, className = "" }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-card border border-border bg-surface p-5 shadow-card ${className}`}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

type KvRow = [label: string, value: ReactNode];

function Kv({ rows }: { rows: KvRow[] }) {
  return (
    <dl className="@container">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-1 gap-0.5 py-1.5 text-sm @[360px]:grid-cols-[112px_minmax(0,1fr)] @[360px]:gap-3">
          <dt className="text-[#4B5563]">{label}</dt>
          <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function initials(name: string): string {
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

const when = (label: string, value: Date | null): KvRow[] => (value ? [[label, formatDate(value)]] : []);

/**
 * Academy detail (design P02): profile, owner and contact, onboarding
 * checklist and payment history on the left; lifecycle actions, the
 * subscription summary, usage bars and the danger zone on the right. All
 * read-only except the existing approval, lifecycle and delete actions,
 * which keep their own server-side checks.
 */
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
        <BackLink href="/platform/academies" label="Academies" />
        <Section>
          <h1 className="text-lg font-semibold text-ink">Academy not found</h1>
          <p className="mt-1 text-sm text-[#374151]">It may have been deleted, or the link is wrong.</p>
        </Section>
      </div>
    );
  }

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

  const now = requestTime();
  const daysLeft = subscription?.endsAt ? Math.ceil((subscription.endsAt.getTime() - now) / DAY_MS) : null;
  const contactName = academy.primaryContactName ?? "Not recorded";
  const { usage, limits } = usageOverview;

  const phoneValue = (phone: string | null, who: string) =>
    phone ? (
      <span className="flex flex-wrap items-center gap-2">
        <a href={`tel:${phone}`}>{phone}</a>
        <ChatActions phone={phone} who={who} variant="pill" />
      </span>
    ) : null;

  return (
    <div className={PAGE_WRAP}>
      <BackLink href="/platform/academies" label="Academies" />

      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[26px] font-bold leading-tight text-ink">{academy.name}</h1>
          <Badge label={approvalLabel(academy.status)} tone={approvalTone(academy.status)} />
        </div>
        <p className="mt-1 text-sm text-[#4B5563]">
          {[academy.planName ? planLabel(academy.planName) : "No plan", academy.type].filter(Boolean).join(" · ")}
        </p>
      </div>

      <div className="@container">
        <div className="grid grid-cols-1 items-start gap-6 @[860px]:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-6">
            <Card title="Profile">
              <Kv
                rows={[
                  ["Slug", <span key="slug" className="font-mono text-[13px]">{academy.slug}</span>],
                  ["Type", academy.type],
                  ["Currency", academy.defaultCurrency],
                  ["Registration no.", academy.registrationNumber],
                  ["Website", academy.website],
                  ["Created", `${formatDate(academy.createdAt)}${academy.createdByEmail ? ` by ${academy.createdByEmail}` : ""}`],
                  ["Approval", <Badge key="approval" label={approvalLabel(academy.status)} tone={approvalTone(academy.status)} />],
                  ...(academy.approvedAt
                    ? ([["Approved", `${formatDate(academy.approvedAt)}${academy.approvedByEmail ? ` by ${academy.approvedByEmail}` : ""}`]] as KvRow[])
                    : []),
                  ["Branches", `${academy.branchCount} active${limits ? ` of ${limits.maxBranches} allowed` : ""}`],
                ]}
              />
              {academy.status === "pending_approval" && (
                <div className="mt-4 border-t border-border pt-4">
                  <ApproveAcademyButton academyId={academy.id} />
                </div>
              )}
            </Card>

            <Card title="Owner and contact">
              <div className="mb-3 flex items-center gap-3 border-b border-border pb-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-tint text-sm font-bold text-brand">
                  {initials(contactName)}
                </span>
                <span className="min-w-0">
                  <span className="block font-semibold text-ink [overflow-wrap:anywhere]">{contactName}</span>
                  <span className="block text-xs text-[#4B5563]">Primary contact</span>
                </span>
              </div>
              <Kv
                rows={[
                  ["Email", academy.email ? <a key="email" href={`mailto:${academy.email}`}>{academy.email}</a> : null],
                  ["Academy phone", phoneValue(academy.phone, academy.name)],
                  ["Contact phone", phoneValue(academy.primaryContactPhone, contactName)],
                  ["Address", academy.address],
                ]}
              />
            </Card>

            {checklist && <OnboardingChecklist status={checklist} />}

            <Card title="Payment history">
              {payments.length === 0 ? (
                <p className="text-sm text-[#4B5563]">No subscription payments recorded yet.</p>
              ) : (
                <ul role="list" className="border-t border-border">
                  {payments.map((payment) => (
                    <li key={payment.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border py-3 last:border-b-0">
                      <span className="min-w-0">
                        <span className="block font-mono text-xs uppercase text-[#374151]" title={payment.id}>
                          {payment.id.slice(0, 8)}
                        </span>
                        <span className="block text-xs text-[#4B5563] [overflow-wrap:anywhere]">
                          {formatCalendarDate(payment.receivedAt)} · {payment.paymentMethod}
                          {payment.verifiedByEmail ? ` · verified by ${payment.verifiedByEmail}` : payment.recordedByEmail ? ` · recorded by ${payment.recordedByEmail}` : ""}
                        </span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="text-sm tabular-nums text-ink">{formatMoney(payment.amountCents, payment.currency)}</span>
                        <Badge label={payment.status} tone={PAYMENT_TONE[payment.status]} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="flex min-w-0 flex-col gap-6">
            <Card title="Lifecycle actions">
              <LifecycleActions
                academyId={academy.id}
                academyName={academy.name}
                subscriptionStatus={subscription?.status ?? null}
                checklistSatisfied={checklist?.allSatisfied ?? false}
                checklistUnmetReasons={checklistUnmetReasons}
                academyClosed={academy.status === "closed"}
              />
            </Card>

            <Card title="Subscription & plan">
              <p className="mb-3 text-xs text-[#4B5563]">Renewals are handled on the Subscriptions page.</p>
              {subscription ? (
                <>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="font-semibold text-ink">{planLabel(subscription.planName)}</span>
                    <Badge label={subscriptionLabel(subscription.effectiveStatus)} tone={subscriptionTone(subscription.effectiveStatus)} />
                    {daysLeft !== null && (
                      <span className="text-sm text-[#4B5563]">
                        {daysLeft > 0
                          ? `Ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`
                          : daysLeft === 0
                            ? "Ends today"
                            : `Ended ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago`}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 border-t border-border pt-2">
                    <Kv
                      rows={[
                        ["Price", `${formatMoney(subscription.priceAmountCents, subscription.currency)} / ${subscription.billingPeriod}`],
                        ["Started", formatDate(subscription.startsAt)],
                        ["Ends", formatDate(subscription.endsAt)],
                        ...when("Trial ends", subscription.trialEndsAt),
                        ...when("Activated", subscription.activatedAt),
                        ...when("Suspended", subscription.suspendedAt),
                        ...when("Cancelled", subscription.cancelledAt),
                        ...when("Renewed", subscription.renewedAt),
                        ...(subscription.notes ? ([["Notes", subscription.notes]] as KvRow[]) : []),
                      ]}
                    />
                  </div>
                </>
              ) : (
                <p className="text-sm text-[#4B5563]">No subscription has been created for this academy yet.</p>
              )}
            </Card>

            <Card
              title="Usage vs. allowances"
              aside={usage ? <span className="text-xs text-[#4B5563]">Snapshot {formatDate(usage.calculatedAt)}</span> : undefined}
            >
              {usage && limits ? (
                <div className="flex flex-col gap-3">
                  <UsageBar label="Branches" current={usage.branchCount} limit={limits.maxBranches} />
                  <UsageBar label="Students" current={usage.activeStudentsCount} limit={limits.maxStudents} />
                  <UsageBar label="Staff" current={usage.activeStaffCount} limit={limits.maxStaff} />
                  <UsageBar label="Courses" current={usage.courseCount} limit={limits.maxCourses} />
                  <UsageBar label="Storage (GB)" current={usage.storageUsedBytes} limit={limits.maxStorageBytes} format={formatGb} />
                </div>
              ) : (
                <p className="text-sm text-[#4B5563]">
                  {limits ? "No usage snapshot yet. " : "No plan allowances to compare. "}
                  <Link href="/platform/usage">Recalculate on the Usage page</Link>.
                </p>
              )}
              <p className="mt-3 text-xs text-[#4B5563]">Display only. Allowances are enforced when records are created.</p>
            </Card>

            <Card title="Danger zone" className="border-[#FECACA]">
              {deletionEligibility.ok ? (
                <DeleteAcademySection eligibility={deletionEligibility.eligibility} />
              ) : (
                <p className="text-sm text-[#4B5563]">{deletionEligibility.error.message}</p>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
