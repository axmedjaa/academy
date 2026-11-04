import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { hasPermission, UNGRANTABLE_CAPABILITIES } from "@/lib/auth/permissions";
import { listPlatformStaff, type PlatformStaffAccount } from "@/lib/platform-staff/staff";
import { AddStaffButton, PlatformStaffManager } from "./platform-staff-manager";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { TabLinks } from "@/app/academy/_shell/page-blocks";
import { ClearFilters, FilterBar, FilterDropdown, SearchField } from "@/app/academy/_shell/filter-controls";
import { PaginationNav } from "@/components/pagination-nav";
import { LIST_PAGE_SIZE_MAX, parsePageParam } from "@/lib/ui/pagination";

const STAFF_MANAGE_CAPABILITY = "platform.staff.manage";
const PAGE_SIZE = LIST_PAGE_SIZE_MAX;

const TABS = ["active", "archived", "all"] as const;
type Tab = (typeof TABS)[number];
const ROLES = ["platform_owner", "platform_admin"] as const;

function one(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function hrefFor(params: Record<string, string | string[] | undefined>, tab: Tab): string {
  const next = new URLSearchParams();
  const q = one(params.q);
  const role = one(params.role);
  if (tab !== "active") next.set("tab", tab);
  if (q) next.set("q", q);
  if (role) next.set("role", role);
  const query = next.toString();
  return query ? `/platform/staff?${query}` : "/platform/staff";
}

// PLAN.md Item 31 / DESIGN.md §8: "/platform/staff... visible and usable by
// platform_owner only — absent entirely from every platform_admin's nav and
// every direct URL, regardless of any grant". "platform.staff.manage" is in
// UNGRANTABLE_CAPABILITIES, so hasPermission() is true here only for an
// active platform_owner; every action re-checks on the server
// (lib/platform-staff/staff.ts), this gate is not the only one.
export default async function PlatformStaffPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();

  if (!context) {
    redirect("/login");
  }

  const allowed = await hasPermission(context, STAFF_MANAGE_CAPABILITY);

  if (!allowed) {
    return <PageMessage title="Access denied" message="You don't have permission to view this page." />;
  }

  const params = await searchParams;
  const tabParam = one(params.tab);
  const tab: Tab = (TABS as readonly string[]).includes(tabParam) ? (tabParam as Tab) : "active";
  const roleParam = one(params.role);
  const role = (ROLES as readonly string[]).includes(roleParam) ? roleParam : "";
  const q = one(params.q).trim().toLowerCase();
  const page = parsePageParam(params);

  // A platform has a handful of staff accounts, so filtering after one
  // fetch is still entirely server-side (same reasoning as
  // app/platform/academies/page.tsx).
  const allStaff = await listPlatformStaff();
  const isArchived = (account: PlatformStaffAccount) => account.archivedAt !== null;
  const counts = {
    all: allStaff.length,
    active: allStaff.filter((account) => !isArchived(account)).length,
    archived: allStaff.filter(isArchived).length,
  };

  const inTab = allStaff.filter((account) =>
    tab === "all" ? true : tab === "archived" ? isArchived(account) : !isArchived(account),
  );
  const filtered = inTab.filter(
    (account) =>
      (!role || account.role === role) &&
      (!q || account.email.includes(q) || (account.fullName ?? "").toLowerCase().includes(q)),
  );
  const totalCount = filtered.length;
  const offset = (page - 1) * PAGE_SIZE;
  const staff = filtered.slice(offset, offset + PAGE_SIZE);

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Platform staff"
        description="People who run the Dardar platform: their role, status and what each Platform Admin can do."
        actions={<AddStaffButton />}
      />
      <TabLinks
        label="Staff status"
        current={tab}
        tabs={[
          { key: "active", label: `Active (${counts.active})`, href: hrefFor(params, "active") },
          { key: "archived", label: `Archived (${counts.archived})`, href: hrefFor(params, "archived") },
          { key: "all", label: `All staff (${counts.all})`, href: hrefFor(params, "all") },
        ]}
      />
      <FilterBar>
        <SearchField placeholder="Search name or email" />
        <FilterDropdown
          param="role"
          label="Role"
          icon="badge"
          options={[
            { value: "", label: "All roles", count: inTab.length },
            {
              value: "platform_owner",
              label: "Platform Owner",
              count: inTab.filter((account) => account.role === "platform_owner").length,
            },
            {
              value: "platform_admin",
              label: "Platform Admin",
              count: inTab.filter((account) => account.role === "platform_admin").length,
            },
          ]}
        />
        <ClearFilters params={["q", "role"]} />
      </FilterBar>
      <PlatformStaffManager
        staff={staff}
        currentUserId={context.userId}
        filtered={Boolean(q || role)}
        tab={tab}
        ungrantableCapabilities={[...UNGRANTABLE_CAPABILITIES]}
      />
      <PaginationNav page={page} pageSize={PAGE_SIZE} totalCount={totalCount} searchParams={params} />
    </div>
  );
}
