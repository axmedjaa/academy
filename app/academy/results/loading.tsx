import { PAGE_WRAP, Pulse, Section, TableWrap, td, th } from "@/app/academy/_shell/ui";

/** Results groups rows into one titled Section per exam (see
 * results-list.tsx) rather than one flat table, so the generic
 * `ListPageSkeleton` (built for a single header+table page) doesn't match
 * this page's real shape — this mirrors the actual "section per exam"
 * composition instead, approximating two exam groups. */
function ExamGroupSkeleton() {
  return (
    <Section>
      <div className="flex items-center justify-between">
        <Pulse className="h-5 w-40" />
        <Pulse className="h-9 w-32" />
      </div>
      <div className="mt-3">
        <TableWrap>
          <thead>
            <tr>
              <th className={th}>
                <Pulse className="h-3 w-16" />
              </th>
              <th className={th}>
                <Pulse className="h-3 w-12" />
              </th>
              <th className={th}>
                <Pulse className="h-3 w-14" />
              </th>
              <th className={th}>
                <Pulse className="h-3 w-12" />
              </th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 3 }).map((_, index) => (
              <tr key={index}>
                <td className={td}>
                  <div className="flex items-center gap-3">
                    <Pulse className="h-8 w-8 shrink-0 rounded-full" />
                    <Pulse className="h-3.5 w-28" />
                  </div>
                </td>
                <td className={td}>
                  <Pulse className="h-3.5 w-10" />
                </td>
                <td className={td}>
                  <Pulse className="h-5 w-20 rounded-full" />
                </td>
                <td className={td}>
                  <Pulse className="h-3.5 w-10" />
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>
    </Section>
  );
}

export default function ResultsLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-24" />
        <Pulse className="h-4 w-72" />
      </div>
      <div className="flex flex-col gap-6">
        <ExamGroupSkeleton />
        <ExamGroupSkeleton />
      </div>
    </div>
  );
}
