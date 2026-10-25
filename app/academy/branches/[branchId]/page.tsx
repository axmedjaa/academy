import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listBranches } from "@/lib/academies/branches";
import { listBatches, type BatchRecord } from "@/lib/academies/batches";
import { listCourses } from "@/lib/academies/courses";
import { listAcademyTimetable } from "@/lib/academies/timetables";
import { getStudentsOverview } from "@/lib/academies/students-overview";
import { DAYS_OF_WEEK, DAY_LABELS, formatTimetableTime } from "@/lib/academies/timetable-constants";
import { formatDate } from "@/lib/ui/date";
import { Badge, BackLink, LinkButton, PAGE_WRAP, PageHeader, PageMessage, humanizeStatus, trHover } from "@/app/academy/_shell/ui";
import { BlockTitle, DataTable, KvCard, NoteBlock, StatBento, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { ChatActions } from "@/app/academy/_shell/chat-actions";
import { BranchActions } from "../branch-actions";

/**
 * One branch: its details, who studies there, the batches it runs and its
 * weekly classes. The design draws Branches as a list only (A05); this page
 * is built from the design's own detail-page blocks (back link, header
 * actions, `kv` card, titled tables, note — as on Batch detail) and shows
 * only data the caller can already reach: every read below applies the same
 * tenant and branch scoping as its list page, and a branch outside the
 * caller's scope is a plain 404.
 */

const BATCH_TONE: Record<BatchRecord["status"], "blue" | "green" | "slate" | "gray"> = {
  planned: "blue",
  active: "green",
  completed: "slate",
  archived: "gray",
};

export default async function BranchDetailPage({ params }: { params: Promise<{ branchId: string }> }) {
  const { branchId } = await params;
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const branchesResult = await listBranches(context);
  if (!branchesResult.ok) {
    return (
      <PageMessage
        title={branchesResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={branchesResult.error.message}
      />
    );
  }
  const branch = branchesResult.branches.find((row) => row.id === branchId);
  if (!branch) notFound();

  const [overviewResult, batchesResult, coursesResult, timetableResult] = await Promise.all([
    getStudentsOverview(context, { branchId: branch.id }),
    listBatches(context),
    listCourses(context),
    listAcademyTimetable(context),
  ]);

  const overview = overviewResult.ok ? overviewResult.overview : null;
  const courseName = new Map((coursesResult.ok ? coursesResult.courses : []).map((course) => [course.id, course.name]));
  const branchBatches = (batchesResult.ok ? batchesResult.batches : [])
    .filter((batch) => batch.branchId === branch.id)
    .sort((a, b) => b.startDate.localeCompare(a.startDate));
  const batchById = new Map(branchBatches.map((batch) => [batch.id, batch]));

  // One row per class: entries sharing batch, time, trainer and room are the
  // same weekly class held on several days.
  const entries = timetableResult.ok ? timetableResult.entries.filter((entry) => entry.branchId === branch.id) : [];
  const classes = new Map<string, { entry: (typeof entries)[number]; days: Set<(typeof entries)[number]["dayOfWeek"]> }>();
  for (const entry of entries) {
    const key = [entry.batchId, entry.startTime, entry.endTime, entry.trainerStaffProfileId ?? "", entry.room ?? ""].join("|");
    const existing = classes.get(key);
    if (existing) existing.days.add(entry.dayOfWeek);
    else classes.set(key, { entry, days: new Set([entry.dayOfWeek]) });
  }
  const classRows = [...classes.values()].sort(
    (a, b) => a.entry.courseName.localeCompare(b.entry.courseName) || a.entry.startTime.localeCompare(b.entry.startTime),
  );

  const activeBatches = branchBatches.filter((batch) => batch.status === "active").length;
  const studentsHref = `/academy/students?branchId=${branch.id}`;

  return (
    <div className={PAGE_WRAP}>
      <BackLink href="/academy/branches" label="All branches" />
      <PageHeader
        title={branch.name}
        description={[
          branch.code,
          humanizeStatus(branch.status),
          `${branchBatches.length} batch${branchBatches.length === 1 ? "" : "es"}`,
        ].join(" · ")}
        actions={
          <>
            {overview && <LinkButton href={studentsHref}>View students</LinkButton>}
            {branchesResult.canManage && <BranchActions branch={branch} layout="header" />}
          </>
        }
      />

      <KvCard
        title="Branch"
        rows={[
          ["Code", branch.code],
          ["Status", <Badge key="status" label={branch.status} tone={branch.status === "archived" ? "gray" : "green"} />],
          ["Address", branch.address ?? <span className="text-muted">Not given</span>],
          [
            "Phone",
            branch.phone ? (
              <span className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="tabular-nums">{branch.phone}</span>
                <ChatActions phone={branch.phone} who={branch.name} variant="pill" />
              </span>
            ) : (
              <span className="text-muted">Not given</span>
            ),
          ],
          ["Added", formatDate(branch.createdAt)],
        ]}
      />

      {overview && (
        <StatBento
          hero={{
            label: "Active students",
            value: overview.active,
            hint: `${overview.total} registered at this branch, ${overview.archived} archived`,
            icon: "group",
            href: `${studentsHref}&status=active`,
          }}
          side={[
            {
              label: "Need enrollment",
              hint: "Active, not in a batch",
              value: overview.needsEnrollment,
              icon: "user_plus",
              tone: "gold",
              href: `${studentsHref}&status=needs`,
            },
            { label: "Active batches", hint: `${branchBatches.length} in total`, value: activeBatches, icon: "layers", tone: "slate" },
            { label: "Weekly classes", hint: "On the timetable", value: classRows.length, icon: "calendar", tone: "slate" },
          ]}
        />
      )}

      <BlockTitle>Batches at this branch</BlockTitle>
      {branchBatches.length === 0 ? (
        <EmptyBlock message="No batches at this branch yet." />
      ) : (
        <DataTable stackBelow={760}>
          <thead>
            <tr>
              <th className={rtTh}>Batch</th>
              <th className={rtTh}>Courses</th>
              <th className={rtTh}>Dates</th>
              <th className={rtTh}>Status</th>
              <th className={rtTh}>Roster</th>
            </tr>
          </thead>
          <tbody>
            {branchBatches.map((batch) => (
              <tr key={batch.id} className={trHover}>
                <td className={`${rtTd} font-semibold`} data-label="Batch">
                  {batch.name}
                  <span className="block text-xs font-normal text-muted">{batch.code}</span>
                </td>
                <td className={rtTd} data-label="Courses">
                  {batch.courseIds.map((id) => courseName.get(id) ?? "Unavailable course").join(", ")}
                </td>
                <td className={`${rtTd} tabular-nums`} data-label="Dates">
                  {formatDate(batch.startDate)}
                  {batch.endDate ? ` to ${formatDate(batch.endDate)}` : ""}
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge label={batch.status} tone={BATCH_TONE[batch.status]} />
                </td>
                <td className={rtTd} data-label="Roster">
                  <Link
                    href={`/academy/batches/${batch.id}`}
                    className="inline-flex min-h-11 items-center font-semibold !text-brand no-underline hover:underline"
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {timetableResult.ok && (
        <>
          <BlockTitle
            actions={
              <Link href="/academy/timetable" className="text-sm font-semibold !text-brand no-underline hover:underline">
                Open timetable
              </Link>
            }
          >
            Weekly classes
          </BlockTitle>
          {classRows.length === 0 ? (
            <EmptyBlock message="No classes scheduled at this branch yet." />
          ) : (
            <DataTable stackBelow={760}>
              <thead>
                <tr>
                  <th className={rtTh}>Course</th>
                  <th className={rtTh}>Batch</th>
                  <th className={rtTh}>Days</th>
                  <th className={rtTh}>Time</th>
                  <th className={rtTh}>Trainer</th>
                  <th className={rtTh}>Room</th>
                </tr>
              </thead>
              <tbody>
                {classRows.map(({ entry, days }) => (
                  <tr key={entry.id} className={trHover}>
                    <td className={`${rtTd} font-semibold`} data-label="Course">
                      {entry.courseName}
                    </td>
                    <td className={rtTd} data-label="Batch">
                      {batchById.get(entry.batchId)?.code ?? entry.batchName}
                    </td>
                    <td className={rtTd} data-label="Days">
                      {DAYS_OF_WEEK.filter((day) => days.has(day))
                        .map((day) => DAY_LABELS[day])
                        .join(", ")}
                    </td>
                    <td className={`${rtTd} whitespace-nowrap tabular-nums`} data-label="Time">
                      {formatTimetableTime(entry.startTime)} to {formatTimetableTime(entry.endTime)}
                    </td>
                    <td className={rtTd} data-label="Trainer">
                      {entry.trainerName ?? <span className="text-muted">No trainer yet</span>}
                    </td>
                    <td className={rtTd} data-label="Room">
                      {entry.room ?? <span className="text-muted">Not set</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </>
      )}

      <NoteBlock>
        {branch.deletionEligibility.eligible
          ? "Nothing references this branch yet, so it can still be deleted. Deleting is blocked once a student or batch uses it."
          : "Deleting a branch is blocked while any student or batch references it. Archive it instead."}
      </NoteBlock>
    </div>
  );
}

function EmptyBlock({ message }: { message: string }) {
  return (
    <div className="mb-8 rounded-card border border-border bg-surface px-4 py-8 text-center text-sm text-muted shadow-card">
      {message}
    </div>
  );
}
