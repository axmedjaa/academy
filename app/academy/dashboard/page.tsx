import { redirect } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getAcademyDashboardData, type MoneySummary } from "@/lib/academies/dashboard";
import { formatMoneyHeadline } from "@/lib/ui/money";
import { buildMonthlyWindow } from "@/lib/ui/monthly-window";
import { Icon } from "@/app/academy/_shell/icons";
import { DashboardTrendChart } from "@/app/academy/_shell/dashboard-trend-chart";
import { Badge, EmptyState, ErrorMessage, UsageBar } from "@/app/academy/_shell/ui";
import { BranchSelect } from "./branch-select";

/**
 * `/academy/dashboard` — Screen Inventory A01, built from the active
 * `Platform Console.dc.html` `isAcadDash` block (HANDOFF.md: the single
 * authoritative design source). Section order, top to bottom:
 *
 *   1. Page header: "Dashboard", "{academy}. Showing {branch}.", branch filter.
 *   2. KPI bento on a 24px gap, laid out by the content's own width
 *      (container queries, matching the reference's content-width rule):
 *      3 columns ≥860px — hero "Total students" spans two rows in column 1,
 *      four cards fill columns 2–3; 2 columns ≥480px — hero full width,
 *      cards 2×2; 1 column below. A full-width burgundy "Payments
 *      collected" strip closes the grid.
 *   3. Recent payments (latest 5) | Requires attention, 1.4fr / 1fr.
 *   4. Enrollment trend | Usage vs. allowances.
 *
 * Every figure comes from `getAcademyDashboardData` (tenant- and
 * branch-scoped, permission-gated per section). A card a role cannot see is
 * omitted, never shown as zero.
 */

const PANEL =
  "dd-lift rounded-[20px] border border-[#E5E7EB] bg-surface p-6 shadow-[0_1px_2px_rgba(17,24,39,0.04),0_8px_20px_-12px_rgba(17,24,39,0.14)]";

const TILE_TONES = [
  { bg: "#F9E8EC", fg: "text-brand" },
  { bg: "rgba(245,182,56,0.28)", fg: "text-ink" },
] as const;

function getInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** Headline for a per-currency total: the largest currency leads; any
 * others are named in the hint rather than summed across currencies. */
function moneyHeadline(summary: MoneySummary | { totalsByCurrency: { currency: string; amountCents: number }[] }) {
  const sorted = [...summary.totalsByCurrency].sort((a, b) => b.amountCents - a.amountCents);
  const lead = sorted[0];
  return {
    value: lead ? formatMoneyHeadline(lead.amountCents, lead.currency) : formatMoneyHeadline(0, "USD"),
    others: sorted.slice(1).map((row) => formatMoneyHeadline(row.amountCents, row.currency)),
  };
}

function plural(n: number, one: string, many: string) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  mobile_money: "Mobile money",
  bank_transfer: "Bank transfer",
};

const PAYMENT_BADGE: Record<string, { label: string; tone: "green" | "amber" | "red" | "slate" }> = {
  approved: { label: "Paid", tone: "green" },
  pending_approval: { label: "Pending", tone: "amber" },
  rejected: { label: "Rejected", tone: "red" },
  reversed: { label: "Reversed", tone: "slate" },
};

function formatShortDate(value: Date | string) {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatExamDate(isoDate: string) {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function HeroCard({ label, value, hint, icon, href }: { label: string; value: string; hint?: string; icon: ReactNode; href: string }) {
  return (
    <Link
      href={href}
      className="relative flex h-full min-h-[200px] flex-col justify-between gap-7 overflow-hidden rounded-[20px] border border-[#F0CDD5] bg-[linear-gradient(135deg,#F9E8EC_0%,#E9C3CC_100%)] p-7 text-ink no-underline shadow-[0_4px_14px_rgba(133,0,25,0.12)] transition-shadow duration-200 hover:no-underline hover:shadow-[0_8px_22px_rgba(133,0,25,0.18)] @[480px]:col-span-2 @[860px]:col-span-1 @[860px]:row-span-2"
    >
      <span aria-hidden="true" className="absolute -right-[50px] -top-[50px] h-[190px] w-[190px] rounded-full border-[30px] border-white/40" />
      <span className="relative flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-white text-brand shadow-[0_1px_3px_rgba(17,24,39,0.12)]">
          {icon}
        </span>
        <span className="font-bold">{label}</span>
      </span>
      <span className="relative block">
        <span className="block text-[56px] font-bold leading-none tracking-[-0.03em] text-brand tabular-nums sm:text-[72px]">
          {value}
        </span>
        {hint && <span className="mt-2.5 block font-medium text-[#374151]">{hint}</span>}
      </span>
    </Link>
  );
}

function KpiCard({
  label,
  value,
  hint,
  icon,
  href,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: ReactNode;
  href?: string;
  tone: (typeof TILE_TONES)[number];
}) {
  const body = (
    <>
      <span
        aria-hidden="true"
        className="absolute -right-7 -top-7 h-24 w-24 rounded-full opacity-70"
        style={{ background: tone.bg }}
      />
      <span
        className={`relative flex h-[46px] w-[46px] items-center justify-center rounded-[14px] bg-white shadow-[0_1px_3px_rgba(17,24,39,0.12),0_0_0_1px_rgba(17,24,39,0.04)] ${tone.fg}`}
      >
        {icon}
      </span>
      <span className="relative block min-w-0">
        <span className="block truncate text-[36px] font-bold leading-none tracking-[-0.025em] text-ink tabular-nums">{value}</span>
        <span className="mt-2.5 block text-[13px] font-semibold leading-tight tracking-[0.02em] text-[#374151]">{label}</span>
        {hint && <span className="mt-[3px] block text-[12.5px] leading-snug text-muted">{hint}</span>}
      </span>
    </>
  );
  const className =
    "relative flex min-w-0 flex-col gap-[22px] overflow-hidden rounded-[20px] border border-[#E5E7EB] p-[22px] text-ink no-underline shadow-[0_1px_2px_rgba(17,24,39,0.04),0_8px_20px_-12px_rgba(17,24,39,0.18)] hover:border-[#D8C3C8] hover:no-underline hover:shadow-[0_6px_18px_rgba(17,24,39,0.08)]";
  const style = { background: `linear-gradient(160deg,#fff 55%,${tone.bg} 160%)` };
  return href ? (
    <Link href={href} className={className} style={style}>
      {body}
    </Link>
  ) : (
    <div className={className} style={style}>
      {body}
    </div>
  );
}

function PaymentsStrip({ value, hint, href }: { value: string; hint: string; href: string }) {
  return (
    <Link
      href={href}
      className="flex flex-wrap items-center gap-x-5 gap-y-4 rounded-2xl bg-brand px-6 py-5 !text-white no-underline shadow-[0_4px_14px_rgba(133,0,25,0.25)] transition-colors duration-150 hover:bg-[#6B0014] hover:text-white hover:no-underline @[480px]:col-span-2 @[860px]:col-span-3"
    >
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-accent-gold text-ink">
        <Icon name="payments" />
      </span>
      <span className="min-w-0 flex-[1_1_200px]">
        <span className="block text-base font-bold">Payments collected</span>
        <span className="mt-0.5 block text-[13px] opacity-90">{hint}</span>
      </span>
      <span className="text-[30px] font-bold tracking-[-0.02em] tabular-nums sm:text-[38px]">{value}</span>
    </Link>
  );
}

type AttentionTone = "red" | "amber" | "blue" | "green";
const ATTENTION_TILE: Record<AttentionTone, string> = {
  red: "bg-[#FEF2F2] text-[#991B1B]",
  amber: "bg-[#FFFBEB] text-[#92400E]",
  blue: "bg-[#EFF6FF] text-[#1E40AF]",
  green: "bg-success-bg text-success",
};

interface AttentionItem {
  key: string;
  title: string;
  line: string;
  icon: string;
  tone: AttentionTone;
  action: string;
  href: string;
}

export default async function AcademyDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const params = await searchParams;
  const branchParam = typeof params.branch === "string" ? params.branch : null;
  const result = await getAcademyDashboardData(context, { branchId: branchParam });
  if (!result.ok) {
    return <ErrorMessage message={result.error.message} />;
  }
  const { data } = result;
  const onlyBranch = data.branchOptions.length === 1 ? data.branchOptions[0] : null;
  const branchCaption = data.selectedBranch
    ? `${data.selectedBranch.name} branch`
    : onlyBranch
      ? `${onlyBranch.name} branch`
      : "all branches";
  const branchQuery = data.selectedBranch ? `?branchId=${data.selectedBranch.id}` : "";

  // --- KPI cards (reference order: Staff, Upcoming exams, Pending approvals, Outstanding charges)
  const cards: { key: string; node: ReactNode }[] = [];
  if (data.activeStaffCount !== null) {
    cards.push({
      key: "staff",
      node: <KpiCard label="Staff" value={data.activeStaffCount.toLocaleString()} hint="Active, all branches" icon={<Icon name="badge" />} href="/academy/staff" tone={TILE_TONES[0]} />,
    });
  }
  if (data.upcomingExamsCount !== null) {
    cards.push({
      key: "exams",
      node: (
        <KpiCard
          label="Upcoming exams"
          value={data.upcomingExamsCount.toLocaleString()}
          hint={data.nextExam ? `Next on ${formatExamDate(data.nextExam.examDate)}` : "None scheduled"}
          icon={<Icon name="fact_check" />}
          href="/academy/exams"
          tone={TILE_TONES[1]}
        />
      ),
    });
  }
  if (data.pendingApprovals !== null) {
    cards.push({
      key: "approvals",
      node: (
        <KpiCard
          label="Pending approvals"
          value={data.pendingApprovals.total.toLocaleString()}
          hint={data.pendingApprovals.total > 0 ? data.pendingApprovals.breakdown : "Results, expenses, grades"}
          icon={<Icon name="pending" />}
          href={data.pendingApprovals.total > 0 ? data.pendingApprovals.href : undefined}
          tone={TILE_TONES[0]}
        />
      ),
    });
  }
  if (data.outstandingCharges !== null) {
    const money = moneyHeadline(data.outstandingCharges);
    cards.push({
      key: "outstanding",
      node: (
        <KpiCard
          label="Outstanding charges"
          value={money.value}
          hint={[plural(data.outstandingCharges.count, "unpaid charge", "unpaid charges"), ...money.others].join(" · ")}
          icon={<Icon name="receipt_long" />}
          href="/academy/finance"
          tone={TILE_TONES[1]}
        />
      ),
    });
  }

  // --- Requires attention (reference order: Overdue, Outstanding, Approvals, Next exam)
  const attention: AttentionItem[] = [];
  if (data.overdueFees) {
    const overdue = moneyHeadline(data.overdueFees);
    attention.push({
      key: "overdue",
      title: "Overdue fees",
      line:
        data.overdueFees.studentCount > 0
          ? `${[overdue.value, ...overdue.others].join(" + ")} overdue from ${plural(data.overdueFees.studentCount, "student", "students")}`
          : "No fee periods are overdue",
      icon: data.overdueFees.studentCount > 0 ? "warning" : "check_circle",
      tone: data.overdueFees.studentCount > 0 ? "red" : "green",
      action: "Collect",
      href: "/academy/finance/fee-periods",
    });
  }
  if (data.outstandingCharges) {
    const outstanding = moneyHeadline(data.outstandingCharges);
    attention.push({
      key: "outstanding",
      title: "Outstanding fees",
      line:
        data.outstandingCharges.count > 0
          ? `${[outstanding.value, ...outstanding.others].join(" + ")} across ${plural(data.outstandingCharges.count, "charge", "charges")}`
          : "No unpaid charges",
      icon: "receipt_long",
      tone: data.outstandingCharges.count > 0 ? "amber" : "green",
      action: "View charges",
      href: "/academy/finance",
    });
  }
  if (data.pendingApprovals) {
    attention.push({
      key: "approvals",
      title: "Pending approvals",
      line:
        data.pendingApprovals.total > 0
          ? `${plural(data.pendingApprovals.total, "item", "items")} waiting for review`
          : "Nothing waiting for review",
      icon: "pending",
      tone: data.pendingApprovals.total > 0 ? "amber" : "green",
      action: "Review",
      href: data.pendingApprovals.href,
    });
  }
  if (data.upcomingExamsCount !== null) {
    attention.push({
      key: "exam",
      title: "Next exam",
      line: data.nextExam
        ? [data.nextExam.name, data.nextExam.batchName, formatExamDate(data.nextExam.examDate)].filter(Boolean).join(", ")
        : "None scheduled",
      icon: "fact_check",
      tone: "blue",
      action: "Open exams",
      href: "/academy/exams",
    });
  }
  const atLimit =
    data.usage?.metrics && data.usage.limits && data.usage.limits.maxStudents > 0
      ? data.usage.metrics.activeStudentsCount >= data.usage.limits.maxStudents
      : false;
  if (atLimit) {
    attention.unshift({
      key: "limit",
      title: "Student allowance reached",
      line: "New admissions are blocked until the plan allows more students",
      icon: "warning",
      tone: "red",
      action: "View usage",
      href: "/academy/settings",
    });
  }
  const openItems = attention.filter((item) => item.tone !== "green" && item.key !== "exam").length;

  const enrollment = data.enrollmentTrend
    ? buildMonthlyWindow(data.enrollmentTrend, { cumulative: true })
    : null;
  const priorMonth = enrollment && enrollment.length > 1 ? enrollment[enrollment.length - 2].label : null;
  const collected = data.paymentsCollected ? moneyHeadline(data.paymentsCollected) : null;

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold leading-tight tracking-tight text-ink">Dashboard</h1>
          <p className="mt-1 text-muted">
            {data.academyName}. Showing {branchCaption}.
          </p>
        </div>
        {data.branchOptions.length > 1 && (
          <BranchSelect options={data.branchOptions} value={data.selectedBranch?.id ?? null} />
        )}
      </div>

      <div className="@container">
        {(data.totalStudents !== null || cards.length > 0 || collected) && (
          <div className="dd-grid mb-8 grid grid-cols-1 gap-6 @[480px]:grid-cols-2 @[860px]:grid-cols-3 [grid-auto-flow:row_dense]">
            {data.totalStudents !== null && (
              <HeroCard
                label="Total students"
                value={data.totalStudents.toLocaleString()}
                hint={data.activeStudents !== null ? `${data.activeStudents.toLocaleString()} active` : undefined}
                icon={<Icon name="group" />}
                href={`/academy/students${branchQuery}`}
              />
            )}
            {cards.map((card) => (
              <div key={card.key} className="flex min-w-0 [&>*]:flex-1">
                {card.node}
              </div>
            ))}
            {collected && data.paymentsCollected && (
              <PaymentsStrip
                value={collected.value}
                hint={[
                  `${plural(data.paymentsCollected.count, "posted payment", "posted payments")}`,
                  ...collected.others,
                ].join(" · ")}
                href="/academy/finance"
              />
            )}
          </div>
        )}

        <div className="mb-6 grid grid-cols-1 items-start gap-6 @[760px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          {data.recentPayments !== null && (
            <section className={PANEL} aria-labelledby="dash-recent-payments">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 id="dash-recent-payments" className="text-base font-bold tracking-[-0.01em] text-ink">
                  Recent payments
                </h2>
                <span className="rounded-full bg-[#ECFDF5] px-2.5 py-1 text-xs font-semibold text-[#047857]">Latest 5</span>
              </div>
              {data.recentPayments.length === 0 ? (
                <EmptyState message="No payments recorded yet." icon={<Icon name="payments" />} />
              ) : (
                <ul className="flex flex-col">
                  {data.recentPayments.map((payment) => {
                    const badge = PAYMENT_BADGE[payment.status] ?? { label: payment.status, tone: "slate" as const };
                    return (
                      <li key={payment.id}>
                        <Link
                          href={`/academy/students/${payment.studentId}`}
                          className="-mx-2.5 flex min-h-[60px] items-center gap-3 rounded-xl px-2.5 py-2.5 text-ink no-underline transition-colors duration-150 hover:bg-app hover:no-underline"
                        >
                          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#F9E8EC,#EBC6CE)] text-xs font-bold text-brand">
                            {getInitials(payment.studentName)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{payment.studentName}</span>
                            <span className="block truncate text-xs text-muted">
                              {METHOD_LABEL[payment.method] ?? payment.method} · {formatShortDate(payment.receivedAt)}
                            </span>
                          </span>
                          <span className="shrink-0 text-right font-medium tabular-nums">
                            {formatMoneyHeadline(payment.amountCents, payment.currency)}
                          </span>
                          <span className="hidden shrink-0 sm:inline-flex">
                            <Badge label={badge.label} tone={badge.tone} />
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="mt-2 border-t border-border pt-3 text-right">
                <Link href="/academy/finance" className="text-sm font-medium !text-brand hover:underline">
                  View all payments
                </Link>
              </div>
            </section>
          )}

          <section className={`${PANEL} ${data.recentPayments === null ? "@[760px]:col-span-2" : ""}`} aria-labelledby="dash-attention">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="dash-attention" className="text-base font-bold tracking-[-0.01em] text-ink">
                Requires attention
              </h2>
              {openItems > 0 ? (
                <span className="rounded-full bg-[#FFFBEB] px-2.5 py-1 text-xs font-semibold text-[#B45309]">
                  {plural(openItems, "to do", "to do")}
                </span>
              ) : (
                <span className="rounded-full bg-[#ECFDF5] px-2.5 py-1 text-xs font-semibold text-[#047857]">All clear</span>
              )}
            </div>
            {attention.length === 0 ? (
              <EmptyState message="Nothing needs your attention right now." icon={<Icon name="check_circle" />} />
            ) : (
              <ul className="flex flex-col">
                {attention.map((item) => (
                  <li
                    key={item.key}
                    className="-mx-2.5 flex flex-wrap items-center gap-3 rounded-xl px-2.5 py-3 transition-colors duration-150 hover:bg-app"
                  >
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${ATTENTION_TILE[item.tone]}`}>
                      <Icon name={item.icon} width={18} height={18} />
                    </span>
                    <span className="min-w-0 flex-[1_1_140px]">
                      <span className="block font-medium text-ink">{item.title}</span>
                      <span className="block text-xs text-muted">{item.line}</span>
                    </span>
                    <Link
                      href={item.href}
                      className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border-strong bg-surface px-3 text-[13px] font-semibold text-ink no-underline transition-colors duration-150 hover:border-brand hover:bg-brand-tint hover:!text-brand hover:no-underline"
                    >
                      {item.action}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {(enrollment || data.usage) && (
          <div className="grid grid-cols-1 gap-6 @[700px]:grid-cols-2">
            {enrollment && (
              <section className={`${PANEL} ${data.usage ? "" : "@[700px]:col-span-2"}`}>
                <DashboardTrendChart
                  title="Enrollment"
                  subtitle="Cumulative enrollments, last 7 months"
                  points={enrollment}
                  noun="enrollments"
                  unit="enrollments"
                  deltaSuffix={priorMonth ? `vs ${priorMonth}` : undefined}
                />
              </section>
            )}
            {data.usage && (
              <section className={`${PANEL} ${enrollment ? "" : "@[700px]:col-span-2"}`}>
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <h2 className="font-semibold text-ink">Usage vs. allowances</h2>
                  <span className="whitespace-nowrap text-xs text-muted">Whole academy</span>
                </div>
                {data.usage.metrics && data.usage.limits ? (
                  <div className="flex flex-col gap-3">
                    <UsageBar label="Students" used={data.usage.metrics.activeStudentsCount} limit={data.usage.limits.maxStudents} />
                    <UsageBar label="Staff" used={data.usage.metrics.activeStaffCount} limit={data.usage.limits.maxStaff} />
                    <UsageBar label="Courses" used={data.usage.metrics.courseCount} limit={data.usage.limits.maxCourses} />
                    <UsageBar label="Branches" used={data.usage.metrics.branchCount} limit={data.usage.limits.maxBranches} />
                    <UsageBar
                      label="Storage (GB)"
                      used={Math.round((data.usage.metrics.storageUsedBytes / 1024 ** 3) * 10) / 10}
                      limit={Math.round((data.usage.limits.maxStorageBytes / 1024 ** 3) * 10) / 10}
                    />
                    <p className="text-xs text-muted">
                      Calculated {formatShortDate(data.usage.metrics.calculatedAt)}.{" "}
                      <Link href="/academy/settings" className="!text-brand hover:underline">Plan details</Link>
                    </p>
                  </div>
                ) : (
                  <EmptyState message="Usage has not been calculated yet." icon={<Icon name="bar_chart" />} />
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
