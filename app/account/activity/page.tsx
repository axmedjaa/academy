import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getMyActivity } from "@/lib/my-activity-actions";
import type { AuditResult } from "@/lib/audit-query";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { Badge, EmptyState, PageHeader } from "@/app/academy/_shell/ui";
import { ClearFilters, DateParamField, FilterBar, FilterDropdown, SearchField } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { PaginationNav } from "@/components/pagination-nav";
import { ACCOUNT_WRAP, AccountTabs, notificationsHrefFor } from "../account-tabs";

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "student_id_card" / "academySettings" -> "Student id card" / "Academy settings". */
function humanizeEntity(value: string): string {
  const words = value
    .replace(/[._-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

/**
 * Activity (design S02): actions taken by the signed-in user's own account,
 * newest first, filtered by action, result and date (URL params). Every
 * row comes from `getMyActivity`, which is hard-scoped on the server to the
 * caller's own `actorUserId`, so no role or permission is involved and no
 * one else's activity can appear here.
 */
export default async function MyActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const params = await searchParams;
  const get = (key: string): string => {
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  };

  const action = get("action").trim();
  const result = get("result") === "success" || get("result") === "failure" ? get("result") : "";
  const createdFrom = get("createdFrom");
  const createdTo = get("createdTo");
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  const filtered = Boolean(action || result || createdFrom || createdTo);

  const [response, access] = await Promise.all([
    getMyActivity(
      {
        action: action || undefined,
        result: (result || undefined) as AuditResult | undefined,
        createdFrom: createdFrom ? new Date(createdFrom) : undefined,
        // Inclusive "to" day: up to the end of that day.
        createdTo: createdTo ? new Date(`${createdTo}T23:59:59.999Z`) : undefined,
      },
      { page },
    ),
    context.platformRole ? Promise.resolve(null) : checkAcademyAccessForContext(context),
  ]);
  const notificationsHref = notificationsHrefFor(access && access.level !== "blocked" ? "academy" : null);

  return (
    <div className={ACCOUNT_WRAP}>
      <AccountTabs current="activity" notificationsHref={notificationsHref} />
      <PageHeader title="Activity" description="Actions taken by your account. Only you can see this page." />

      <FilterBar>
        <SearchField param="action" placeholder="Exact action, for example login" />
        <FilterDropdown
          param="result"
          label="Result"
          icon="check_circle"
          options={[
            { value: "", label: "Any" },
            { value: "success", label: "Success" },
            { value: "failure", label: "Failure" },
          ]}
        />
        <DateParamField param="createdFrom" label="From" />
        <DateParamField param="createdTo" label="To" />
        <ClearFilters params={["action", "result", "createdFrom", "createdTo"]} />
      </FilterBar>

      {!response.ok ? (
        <div role="alert" className="mb-6 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2.5 text-[13px] text-[#991B1B]">
          {response.error.message}
        </div>
      ) : response.data.rows.length === 0 ? (
        <section className="mb-6 rounded-card border border-border bg-surface p-6 shadow-card">
          <EmptyState
            message={filtered ? "No activity matches these filters." : "No activity recorded on your account yet."}
            icon={<Icon name="history" />}
          />
        </section>
      ) : (
        <>
          <section className="mb-3 overflow-hidden rounded-card border border-border bg-surface shadow-card">
            <ul role="list">
              {response.data.rows.map((row) => (
                <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border px-4 py-3 last:border-b-0">
                  <span className="min-w-0 flex-[1_1_220px]">
                    <span className="block font-mono text-[13px] font-medium text-ink [overflow-wrap:anywhere]">{row.action}</span>
                    <span className="block text-xs text-muted">
                      {humanizeEntity(row.entityType)}
                      {row.result === "failure" && row.failureReason ? ` · ${row.failureReason}` : ""}
                    </span>
                  </span>
                  <span className="whitespace-nowrap text-[13px] tabular-nums text-muted">{WHEN.format(row.createdAt)}</span>
                  <span className="flex w-[92px] justify-end">
                    <Badge label={row.result === "success" ? "Success" : "Failure"} tone={row.result === "success" ? "green" : "red"} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <p className="mb-4 text-[13px] text-muted">
            Showing {response.data.rows.length} of {response.data.totalCount}.
          </p>
          {response.data.totalCount > response.data.pageSize && (
            <PaginationNav page={response.data.page} pageSize={response.data.pageSize} totalCount={response.data.totalCount} searchParams={params} />
          )}
        </>
      )}
    </div>
  );
}
