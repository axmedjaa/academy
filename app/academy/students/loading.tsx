import { PAGE_WRAP, Section, TableWrap, td, th } from "@/app/academy/_shell/ui";

/** Shape-matched skeleton for `/academy/students` — mirrors the real page's
 * header/search-toolbar/table structure (rather than the older generic
 * `SkeletonBlock` stack a few other pages use) so nothing visibly reflows
 * once real data replaces it. `animate-pulse` is Tailwind's built-in
 * utility; `motion-reduce:animate-none` keeps it a static placeholder under
 * `prefers-reduced-motion: reduce`. */
function Pulse({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse motion-reduce:animate-none rounded-control bg-app ${className}`} />;
}

export default function StudentsLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Pulse className="h-7 w-40" />
          <Pulse className="h-4 w-72" />
        </div>
        <Pulse className="h-9 w-36" />
      </div>

      <Section className="mb-6">
        <div className="flex flex-wrap items-end gap-3">
          <Pulse className="h-[38px] min-w-[240px] flex-1" />
          <Pulse className="h-[38px] w-40" />
          <Pulse className="h-[38px] w-24" />
        </div>
      </Section>

      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Student</th>
            <th className={th}>Status</th>
            <th className={`${th} hidden md:table-cell`}>Course / Batch</th>
            <th className={`${th} text-right`}>Remaining</th>
            <th className={th}>Payment Status</th>
            <th className={`${th} text-right`}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 8 }).map((_, index) => (
            <tr key={index}>
              <td className={td}>
                <div className="flex items-center gap-3">
                  <Pulse className="h-9 w-9 shrink-0 rounded-full" />
                  <div className="flex flex-col gap-1.5">
                    <Pulse className="h-3.5 w-32" />
                    <Pulse className="h-3 w-20" />
                  </div>
                </div>
              </td>
              <td className={td}>
                <Pulse className="h-5 w-16 rounded-full" />
              </td>
              <td className={`${td} hidden md:table-cell`}>
                <Pulse className="h-3.5 w-36" />
              </td>
              <td className={`${td} text-right`}>
                <Pulse className="ml-auto h-3.5 w-16" />
              </td>
              <td className={td}>
                <Pulse className="h-5 w-24 rounded-full" />
              </td>
              <td className={`${td} text-right`}>
                <Pulse className="ml-auto h-8 w-8 rounded-control" />
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </div>
  );
}
