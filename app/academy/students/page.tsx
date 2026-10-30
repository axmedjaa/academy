import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import {
  canManageStudents,
  getStudentPhotoUrl,
  searchStudents,
  STUDENTS_PERMISSION_ACTION,
  type StudentSearchFilters,
} from "@/lib/academies/students";
import { getStudentsOverview, type PaymentFilter } from "@/lib/academies/students-overview";
import { getActiveCoursesForStudents } from "@/lib/academies/batch-assignments";
import { canManageFeePeriodPayments, getStudentPaymentSummaries } from "@/lib/academies/fee-periods";
import { listBranches } from "@/lib/academies/branches";
import { ACADEMY_FEE_PERIODS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { formatMoney } from "@/lib/ui/money";
import { getEnrollBatchOptions } from "@/lib/academies/enroll-options";
import { StudentsList } from "./students-list";
import { StudentsExportButton } from "./students-export-button";
import { RegisterStudentButton } from "./register-student-form";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { NoteBlock, StatBento } from "@/app/academy/_shell/page-blocks";
import { ClearFilters, FilterBar, FilterDropdown, SearchField } from "@/app/academy/_shell/filter-controls";
import { PaginationNav } from "@/components/pagination-nav";

/**
 * `/academy/students` — Screen Inventory A02, built from the active design
 * (academy-engine.js `a_students` list view): header with Register student
 * and Export CSV, the `bento` summary (active students, archived, overdue
 * fees, outstanding balance), a filter bar (search, Status, Branch, Batch,
 * Payment), the student list, and a note.
 *
 * Filters are URL params so the server filters and paginates: `q`,
 * `status` (active | archived | needs), `branchId`, `batch`, `pay`
 * (unpaid | overdue | paid), `page`. Everything is scoped exactly like
 * `searchStudents` (tenant, Trainer's taught students); summary numbers come
 * from `getStudentsOverview` with the same scope, and money figures only
 * appear for roles that can read fee periods. The design's "City" filter is
 * derived from the branch name, so this page filters by Branch.
 */
const PAY_LABEL: Record<PaymentFilter, string> = { unpaid: "Unpaid balance", overdue: "Overdue", paid: "Paid in full" };

function moneyLine(totals: { currency: string; amountCents: number }[]): string {
  if (totals.length === 0) return formatMoney(0, "USD");
  return totals.map((row) => formatMoney(row.amountCents, row.currency)).join(" + ");
}

export default async function AcademyStudentsPage({
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

  const searchTerm = get("q");
  const branchId = get("branchId");
  const statusParam = get("status");
  const batchId = get("batch");
  const payParam = get("pay");
  const pay = payParam === "unpaid" || payParam === "overdue" || payParam === "paid" ? payParam : null;
  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;

  const filters: StudentSearchFilters = {
    searchTerm: searchTerm || undefined,
    branchId: branchId || undefined,
    status: statusParam === "active" || statusParam === "archived" ? statusParam : undefined,
    needsEnrollment: statusParam === "needs" || undefined,
    batchId: batchId && batchId !== "none" ? batchId : undefined,
  };
  if (batchId === "none") filters.needsEnrollment = true;

  // Performance plan P4: the summary, the student search, the branch list
  // and the enroll options are independent, so they load together. The one
  // dependency is kept: a Payment filter (`pay`) searches within the
  // overview's own id lists, so only then does the search wait for it.
  // `canManage` for the enroll options comes from the same gate result and
  // permission rule searchStudents uses (the gate is cached per request).
  const access = await checkAcademyAccessForContext(context);
  const canManageByRole =
    access.level !== "blocked" && canManageStudents(getAcademyPermissionLevel(access.membershipRole, STUDENTS_PERMISSION_ACTION));
  const overviewPromise = getStudentsOverview(context, { branchId: branchId || undefined });
  const [overviewResult, result, branchesResult, enrollOptions] = await Promise.all([
    overviewPromise,
    pay
      ? overviewPromise.then((overviewForPay) =>
          searchStudents(
            context,
            { ...filters, studentIds: overviewForPay.ok ? (overviewForPay.overview.finance?.paymentIds[pay] ?? []) : [] },
            { page },
          ),
        )
      : searchStudents(context, filters, { page }),
    listBranches(context),
    canManageByRole ? getEnrollBatchOptions(context) : Promise.resolve({ canEnroll: false, batches: [] }),
  ]);
  const overview = overviewResult.ok ? overviewResult.overview : null;

  if (!result.ok) {
    return (
      <PageMessage
        title={result.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={result.error.message}
      />
    );
  }

  const { data, canManage, canDelete, membershipRole } = result;
  // Branch-limited roles (Admissions Officer, Trainer) keep their existing
  // restriction on branch transfers in the edit dialog; student visibility
  // itself is decided by searchStudents' own scope.
  const branchLimited = membershipRole === "admissions_officer" || membershipRole === "trainer";
  const isTrainer = membershipRole === "trainer";

  // listBranches applies its own scoping (assigned branches for
  // branch-limited roles), so it serves both the Branch filter (academy-wide
  // roles only) and the registration dialog's branch choice.
  const branchOptions = branchesResult.ok ? branchesResult.branches.filter((branch) => branch.status === "active") : [];

  const hasActiveFilters = Boolean(searchTerm || branchId || statusParam || batchId || pay);

  const academyId = access.level !== "blocked" ? access.academyId : null;
  // Record payment needs the fee-periods "manage" gate (the permission
  // recordFeePeriodPayment itself requires), independent of student edit.
  const canManagePayments =
    access.level !== "blocked" &&
    canManageFeePeriodPayments(getAcademyPermissionLevel(access.membershipRole, ACADEMY_FEE_PERIODS_ACTION));

  // Signed photo URLs are resolved server-side (R2 credentials never reach
  // the browser); a missing entry falls back to initials.
  const [[coursesByStudent, paymentSummaries], photoEntries] = await Promise.all([
    academyId
      ? Promise.all([
          getActiveCoursesForStudents(academyId, data.rows.map((s) => s.id)),
          getStudentPaymentSummaries(academyId, data.rows.map((s) => s.id)),
        ])
      : Promise.resolve([new Map(), new Map()] as const),
    Promise.all(
      data.rows
        .filter((student) => student.profileImageRef)
        .map(async (student) => {
          const url = await getStudentPhotoUrl(student.profileImageRef);
          return url ? ([student.id, url] as const) : null;
        }),
    ),
  ]);
  const photoUrlByStudentId = new Map(photoEntries.filter((entry): entry is readonly [string, string] => entry !== null));

  const description = isTrainer
    ? "Showing students enrolled in the batches you teach."
    : canManage
      ? "You can search, view and edit students across this academy."
      : "You can view every student in this academy (read-only).";

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Students"
        description={description}
        actions={
          <>
            {canManage && branchOptions.length > 0 && (
              <RegisterStudentButton
                openedByUrl={get("register") === "1"}
                branches={branchOptions.map((branch) => ({ id: branch.id, name: branch.name }))}
                enrollBatches={enrollOptions.batches}
              />
            )}
            <StudentsExportButton
              filters={{
                searchTerm: filters.searchTerm,
                branchId: filters.branchId,
                status: filters.status,
                batchId: filters.batchId,
                needsEnrollment: filters.needsEnrollment,
                payment: pay ?? undefined,
              }}
            />
          </>
        }
      />

      {overview && (
        <StatBento
          hero={{
            label: "Active students",
            value: overview.active,
            hint: `${overview.enrolled} enrolled in a batch, ${overview.needsEnrollment} applied`,
            icon: "group",
          }}
          side={[
            { label: "Archived", value: overview.archived, hint: "not counted as active", icon: "badge" },
            ...(overview.finance
              ? [
                  {
                    label: "Overdue fees",
                    value: moneyLine(overview.finance.overdueTotals),
                    hint: `${overview.finance.overdueStudentCount} student${overview.finance.overdueStudentCount === 1 ? "" : "s"}`,
                    icon: "warning",
                  },
                  {
                    label: "Outstanding balance",
                    value: moneyLine(overview.finance.outstandingTotals),
                    hint: "fee periods and charges",
                    icon: "receipt_long",
                  },
                ]
              : []),
          ]}
        />
      )}

      <FilterBar>
        <SearchField placeholder="Search by name or student number" />
        {overview && (
          <FilterDropdown
            param="status"
            label="Status"
            icon="pending"
            options={[
              { value: "", label: "All students", count: overview.total },
              { value: "active", label: "Active", count: overview.active },
              { value: "needs", label: "Needs enrollment", count: overview.needsEnrollment },
              { value: "archived", label: "Archived", count: overview.archived },
            ]}
          />
        )}
        {!branchLimited && branchOptions.length > 1 && (
          <FilterDropdown
            param="branchId"
            label="Branch"
            icon="apartment"
            options={[
              { value: "", label: "All branches" },
              ...branchOptions.map((branch) => ({
                value: branch.id,
                label: branch.name,
                count: branchId ? undefined : (overview?.byBranch[branch.id] ?? 0),
              })),
            ]}
          />
        )}
        {overview && (overview.batches.length > 0 || overview.noBatch > 0) && (
          <FilterDropdown
            param="batch"
            label="Batch"
            icon="layers"
            options={[
              { value: "", label: "All batches", count: overview.total },
              ...overview.batches.map((batch) => ({ value: batch.id, label: batch.name, count: batch.count })),
              { value: "none", label: "No batch yet", count: overview.noBatch },
            ]}
          />
        )}
        {overview?.finance && (
          <FilterDropdown
            param="pay"
            label="Payment"
            icon="payments"
            options={[
              { value: "", label: "Any payment status", count: overview.total },
              ...(["unpaid", "overdue", "paid"] as const).map((key) => ({
                value: key,
                label: PAY_LABEL[key],
                count: overview.finance!.paymentIds[key].length,
              })),
            ]}
          />
        )}
        <ClearFilters params={["q", "status", "branchId", "batch", "pay"]} />
      </FilterBar>

      <StudentsList
        students={data.rows}
        canManage={canManage}
        canDelete={canDelete}
        canManagePayments={canManagePayments}
        showBranchField={!branchLimited}
        coursesByStudent={coursesByStudent}
        photoUrlByStudentId={photoUrlByStudentId}
        paymentSummaries={paymentSummaries}
        overdueByStudent={overview?.finance?.overdueByStudent ?? {}}
        enrollBatches={enrollOptions.batches}
        canEnroll={enrollOptions.canEnroll}
        hasActiveFilters={hasActiveFilters}
        canRegister={canManage && branchOptions.length > 0}
      />

      <PaginationNav page={data.page} pageSize={data.pageSize} totalCount={data.totalCount} searchParams={params} />

      {canDelete && (
        <NoteBlock>
          Delete is only offered when a student has no enrollment, payments or results. Open a student to edit or record
          payments.
        </NoteBlock>
      )}
    </div>
  );
}
