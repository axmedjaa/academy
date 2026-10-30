import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission } from "@/lib/auth/permissions";
import { listAcademiesPage } from "@/lib/academies/approve";
import Link from "next/link";
import { Badge, EmptyState, LinkButton, PAGE_WRAP, PageHeader, PageMessage, Section, trHover } from "@/app/academy/_shell/ui";
import { DataTable, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { formatDate } from "@/lib/ui/date";
import { approvalLabel, approvalTone, subscriptionLabel, subscriptionTone } from "../_shared/status";
import { Icon } from "@/app/academy/_shell/icons";
import { PaginationNav } from "@/components/pagination-nav";
import { LIST_PAGE_SIZE_MAX, parsePageParam } from "@/lib/ui/pagination";

const PAGE_SIZE = LIST_PAGE_SIZE_MAX;

// "approveAcademy" is in UNGRANTABLE_CAPABILITIES (lib/auth/permissions.ts),
// so hasPermission() returns true here only for platform_owner. DESIGN.md
// §5's Master Permission Matrix lists the whole "Academies (register/
// approve/activate/suspend/close)" area as "— (never grantable)" for
// platform_admin (a dash, not "View" — unlike academy_owner's "View own"),
// so gating the list page itself on this capability (not just the mutation)
// matches that row: the page is absent for every platform_admin regardless
// of grants, same as /platform/staff and /platform/plans.
const ACADEMIES_CAPABILITY = "approveAcademy";

export default async function AcademiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, ACADEMIES_CAPABILITY);

  if (!allowed) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  // Perf investigation (Afoogy slow-dashboard task): this page previously
  // called `listAcademies()` — every academy on the platform (2,700+ at
  // measured scale), joined and enriched with a subscription-summary and
  // branch-count batch lookup over all of them — then sliced the array
  // down to 15 rows in JS. Measured at ~2-3s on its own for that reason.
  // `listAcademiesPage()` pushes the LIMIT/OFFSET down to Postgres and
  // scopes every batch lookup to just this page's 15 academy ids instead.
  // `listAcademies()` itself is untouched and still used where it must
  // keep returning every row (e.g. lib/academies/onboarding-checklist.ts).
  const params = await searchParams;
  const page = parsePageParam(params);
  const { academies, totalCount } = await listAcademiesPage({ page, pageSize: PAGE_SIZE });

  const from = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, totalCount);

  // Design P02: name and slug together, two independent badges (approval,
  // subscription), plan, branches and created date. Owner only; no search,
  // filter or export (B11). Student count stays out of this list.
  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Academies"
        description="Every registered academy, with approval and subscription state."
        actions={<LinkButton href="/platform/academies/new">Register academy</LinkButton>}
      />
      <p className="mb-3 text-[13px] text-muted">
        Showing {totalCount.toLocaleString("en-US")} {totalCount === 1 ? "academy" : "academies"}
      </p>

      {academies.length === 0 ? (
        <Section className="mb-8">
          <EmptyState
            message="No academies registered yet. Register the first one to start its subscription."
            icon={<Icon name="apartment" />}
            action={<LinkButton href="/platform/academies/new">Register academy</LinkButton>}
          />
        </Section>
      ) : (
        <DataTable stackBelow={900}>
          <thead>
            <tr>
              <th className={rtTh}>Academy</th>
              <th className={rtTh}>Plan</th>
              <th className={rtTh}>Approval</th>
              <th className={rtTh}>Subscription</th>
              <th className={`${rtTh} text-right`}>Branches</th>
              <th className={rtTh}>Created</th>
            </tr>
          </thead>
          <tbody>
            {academies.map((academy) => (
              <tr key={academy.id} className={trHover}>
                <td className={rtTd} data-label="Academy">
                  <Link
                    href={`/platform/academies/${academy.id}`}
                    className="block min-h-11 py-0.5 font-semibold !text-ink no-underline hover:!text-brand hover:underline"
                  >
                    <span className="block [overflow-wrap:anywhere]">{academy.name}</span>
                    <span className="block font-mono text-xs font-normal text-muted [overflow-wrap:anywhere]">{academy.slug}</span>
                  </Link>
                </td>
                <td className={rtTd} data-label="Plan">
                  {academy.planName ?? <span className="text-muted">No plan</span>}
                </td>
                <td className={rtTd} data-label="Approval">
                  <Badge label={approvalLabel(academy.status)} tone={approvalTone(academy.status)} />
                </td>
                <td className={rtTd} data-label="Subscription">
                  <Badge label={subscriptionLabel(academy.subscriptionStatus)} tone={subscriptionTone(academy.subscriptionStatus)} />
                </td>
                <td className={`${rtTd} text-right tabular-nums`} data-label="Branches">
                  {academy.branchCount}
                </td>
                <td className={`${rtTd} whitespace-nowrap`} data-label="Created">
                  {formatDate(academy.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">
          {totalCount > 0 ? `Showing ${from}–${to} of ${totalCount.toLocaleString("en-US")}` : ""}
        </p>
        <PaginationNav page={page} pageSize={PAGE_SIZE} totalCount={totalCount} searchParams={params} />
      </div>
    </div>
  );
}
