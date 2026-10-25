import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import QRCode from "qrcode";
import { db } from "@/lib/db";
import { academies } from "@/lib/db/schema";
import { getAuthContext } from "@/lib/auth/auth-context";
import { ACADEMY_STUDENTS_ACTION, getAcademyPermissionLevel } from "@/lib/auth/academy-permissions";
import { checkAcademyAccessForContext } from "@/lib/academies/access-gate";
import { getAcademyLogoUrl } from "@/lib/academies/academy-logo";
import { listBranches } from "@/lib/academies/branches";
import { checkIdCardAccess, getIdCard, getIdCardBranchScope, listLatestCardsForStudents } from "@/lib/academies/id-cards";
import { getStudentPhotoUrlsByIds, searchStudents } from "@/lib/academies/students";
import { getActiveCoursesForStudents } from "@/lib/academies/batch-assignments";
import { formatDate } from "@/lib/ui/date";
import { Badge, BackLink, EmptyState, PAGE_WRAP, PageHeader, PageMessage, Section } from "@/app/academy/_shell/ui";
import { DataTable, NoteBlock, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { FilterBar, SearchField } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { PaginationNav } from "@/components/pagination-nav";
import { IdCardHeaderActions, IdCardPhotoField, ReprintButton } from "./id-card-lookup";
import { IdCardPreview } from "./id-card-visual";

const NOTE = "Cards have no expiry date. Issuing always creates a new card; reprinting only counts prints.";

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

type ActiveCourse = { batchName: string };

/**
 * ID cards (design A18). Without `?student=`: search a student by name or
 * number and see whether they have a card. With it: that student's card,
 * front and back, the photo printed on it, every card issued to them with
 * Reprint, and Print / Issue new card in the header. Students come from the
 * scoped student search and the scoped card lookup (tenant and branch rules
 * apply); issuing and reprinting are the existing audited actions.
 */
export default async function AcademyIdCardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const context = await getAuthContext();
  if (!context) redirect("/login");

  const access = await checkIdCardAccess(context);
  if (!access.ok) {
    return (
      <PageMessage
        title={access.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={access.error.message}
      />
    );
  }

  const params = await searchParams;
  const get = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  };
  const q = get("q").trim();
  const selected = get("student");
  const description = access.canManage
    ? "Search a student by name or number, then issue a new card or reprint an existing one."
    : "Search a student by name or number to see their card.";
  const listHref = `/academy/id-cards${q ? `?q=${encodeURIComponent(q)}` : ""}`;

  const gate = await checkAcademyAccessForContext(context);
  const academyId = gate.level === "blocked" ? null : gate.academyId;

  if (selected) {
    const cardResult = await getIdCard(context, selected);
    if (!cardResult.ok) {
      return (
        <div className={PAGE_WRAP}>
          <BackLink href={listHref} label="Choose another student" />
          <PageHeader title="ID cards" description={description} />
          <div role="alert" className="mb-6 rounded-lg border border-[#FECACA] bg-[#FEF2F2] px-3 py-2.5 text-[13px] text-[#991B1B]">
            {cardResult.error.message}
          </div>
        </div>
      );
    }
    const studentId = cardResult.studentId;
    const [lookup, photos, coursesByStudent, branchesResult, academyRows] = await Promise.all([
      searchStudents(context, { studentIds: [studentId] }, { pageSize: 1 }),
      getStudentPhotoUrlsByIds(context, [studentId]),
      academyId ? getActiveCoursesForStudents(academyId, [studentId]) : Promise.resolve(new Map<string, ActiveCourse[]>()),
      listBranches(context),
      academyId
        ? db
            .select({ name: academies.name, address: academies.address, phone: academies.phone, logoRef: academies.logoRef })
            .from(academies)
            .where(eq(academies.id, academyId))
            .limit(1)
        : Promise.resolve([]),
    ]);
    const student = lookup.ok ? lookup.data.rows[0] : undefined;
    const academyRow = academyRows[0];
    const photoUrl = photos.get(studentId) ?? null;
    const card = cardResult.card;
    const batchNames = [...new Set(((coursesByStudent.get(studentId) ?? []) as ActiveCourse[]).map((c) => c.batchName))];
    const branch = (branchesResult.ok ? branchesResult.branches.find((b) => b.id === student?.branchId)?.name : undefined) ?? "Branch";
    const studentName = student?.fullName ?? "Student";
    const studentNumber = student?.studentNumber ?? "";
    // The QR holds only what is printed on the card (student and card number).
    const qrDataUrl = card ? await QRCode.toDataURL(`DARDAR-ID|${studentNumber}|${card.cardNumber}`, { margin: 0, width: 160 }) : null;
    const studentsLevel = gate.level === "blocked" ? "none" : getAcademyPermissionLevel(gate.membershipRole, ACADEMY_STUDENTS_ACTION);
    const canEditPhoto = studentsLevel === "full" || studentsLevel === "manage";

    return (
      <div className={PAGE_WRAP}>
        <BackLink href={listHref} label="Choose another student" />
        <PageHeader
          title="ID cards"
          description={description}
          actions={<IdCardHeaderActions studentId={studentId} hasCard={card !== null} canManage={access.canManage} />}
        />

        <IdCardPreview
          card={card}
          studentName={studentName}
          studentNumber={studentNumber}
          batch={batchNames.length ? batchNames.join(", ") : "Not enrolled"}
          branch={branch}
          academy={{
            name: academyRow?.name ?? "Academy",
            address: academyRow?.address ?? null,
            phone: academyRow?.phone ?? null,
            logoUrl: academyRow?.logoRef ? await getAcademyLogoUrl(academyRow.logoRef) : null,
          }}
          photoUrl={photoUrl}
          qrDataUrl={qrDataUrl}
        />

        <section className="mb-6 rounded-card border border-border bg-surface px-4 py-4 shadow-card">
          <h2 className="text-sm font-semibold text-ink">Student photo</h2>
          <p className="mb-3 text-[13px] text-muted">It appears on the front of the card and on the student&apos;s page.</p>
          {canEditPhoto ? (
            <IdCardPhotoField studentId={studentId} photoUrl={photoUrl} />
          ) : (
            <p className="text-[13px] text-muted">
              {photoUrl ? "A photo is on file." : "No photo yet."} Staff who manage students can change it.
            </p>
          )}
        </section>

        <DataTable stackBelow={600}>
          <thead>
            <tr>
              <th className={rtTh}>Card</th>
              <th className={rtTh}>Issued</th>
              <th className={rtTh}>Printed</th>
              {access.canManage && (
                <th className={rtTh}>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {cardResult.cards.length === 0 ? (
              <tr>
                <td colSpan={access.canManage ? 4 : 3} className="px-4 py-8 text-center text-[13px] text-muted">
                  This student has no card yet.
                </td>
              </tr>
            ) : (
              cardResult.cards.map((row, index) => (
                <tr key={row.id}>
                  <td className={rtTd} data-label="Card">
                    <span className="font-mono font-semibold text-ink">{row.cardNumber}</span>
                    {index === 0 && cardResult.cards.length > 1 && <span className="ml-2 text-xs text-muted">Latest</span>}
                  </td>
                  <td className={`${rtTd} tabular-nums`} data-label="Issued">
                    {formatDate(row.issuedAt)}
                  </td>
                  <td className={`${rtTd} tabular-nums`} data-label="Printed">
                    {row.reprintCount + 1}
                  </td>
                  {access.canManage && (
                    <td className={`${rtTd} text-right`} data-actions="">
                      <ReprintButton studentId={studentId} cardId={row.id} cardNumber={row.cardNumber} />
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </DataTable>

        <NoteBlock>{NOTE}</NoteBlock>
      </div>
    );
  }

  const pageParam = Number.parseInt(get("page"), 10);
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
  // Branch-limited roles are offered only students whose card they can open.
  const branchIds = await getIdCardBranchScope(context);
  const result = await searchStudents(
    context,
    { searchTerm: q || undefined, status: "active", ...(branchIds ? { branchIds } : {}) },
    { page, pageSize: 15 },
  );
  const rows = result.ok ? result.data.rows : [];
  const ids = rows.map((row) => row.id);
  const [cardsResult, photos, coursesByStudent] = await Promise.all([
    listLatestCardsForStudents(context, ids),
    getStudentPhotoUrlsByIds(context, ids),
    academyId ? getActiveCoursesForStudents(academyId, ids) : Promise.resolve(new Map<string, ActiveCourse[]>()),
  ]);
  const cards = cardsResult.ok ? cardsResult.cards : {};

  const linkFor = (studentId: string) => {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    next.set("student", studentId);
    return `/academy/id-cards?${next.toString()}`;
  };

  return (
    <div className={PAGE_WRAP}>
      <PageHeader title="ID cards" description={description} />

      <FilterBar>
        <SearchField placeholder="Search by name or student number" />
      </FilterBar>

      {rows.length === 0 ? (
        <Section className="mb-8">
          <EmptyState message={q ? "No active student matches that search." : "No active students yet."} icon={<Icon name="idcard" />} />
        </Section>
      ) : (
        <section className="mb-8 overflow-hidden rounded-card border border-border bg-surface shadow-card">
          <ul role="list">
            {rows.map((row) => {
              const card = cards[row.id];
              const batches = [...new Set(((coursesByStudent.get(row.id) ?? []) as ActiveCourse[]).map((c) => c.batchName))];
              const photo = photos.get(row.id) ?? null;
              return (
                <li key={row.id} className="border-b border-border last:border-b-0">
                  <Link
                    href={linkFor(row.id)}
                    className="flex min-h-16 items-center gap-3 px-4 py-3 no-underline transition-colors duration-150 hover:bg-app hover:no-underline"
                  >
                    {photo ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed storage URL
                      <img src={photo} alt="" className="h-11 w-11 shrink-0 rounded-full object-cover" />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-tint text-sm font-bold text-brand"
                      >
                        {initialsOf(row.fullName)}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold text-ink [overflow-wrap:anywhere]">{row.fullName}</span>
                      <span className="block text-[13px] text-muted">
                        {row.studentNumber} · {batches.length ? batches.join(", ") : "Not enrolled"}
                      </span>
                    </span>
                    <span className="shrink-0">
                      {card ? <Badge label="Card issued" tone="green" /> : <Badge label="No card yet" tone="gray" />}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {result.ok && result.data.totalCount > result.data.pageSize && (
            <div className="border-t border-border px-4 py-3">
              <PaginationNav page={result.data.page} pageSize={result.data.pageSize} totalCount={result.data.totalCount} searchParams={params} />
            </div>
          )}
        </section>
      )}

      <NoteBlock>{NOTE}</NoteBlock>
    </div>
  );
}
