import { PAGE_WRAP, Pulse, Section, TableWrap, td, th } from "@/app/academy/_shell/ui";

/** Shape-matched skeleton — replaces the old generic `SkeletonBlock` stack
 * (three same-size blocks unrelated to the real layout) with something
 * resembling Finance's actual composition: a tab bar + table for
 * Charges/Payments, then the same shape again for Income/Expenses. */
function TabbedTableSkeleton() {
  return (
    <Section>
      <div className="mb-4 flex gap-2">
        <Pulse className="h-7 w-20 rounded-full" />
        <Pulse className="h-7 w-20 rounded-full" />
      </div>
      <TableWrap>
        <thead>
          <tr>
            {Array.from({ length: 5 }).map((_, index) => (
              <th key={index} className={th}>
                <Pulse className="h-3 w-16" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 4 }).map((_, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: 5 }).map((_, colIndex) => (
                <td key={colIndex} className={td}>
                  <Pulse className={colIndex === 0 ? "h-3.5 w-28" : "h-3.5 w-16"} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </Section>
  );
}

export default function FinanceLoading() {
  return (
    <div className={PAGE_WRAP}>
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-24" />
        <Pulse className="h-4 w-96" />
      </div>
      <div className="flex flex-col gap-8">
        <TabbedTableSkeleton />
        <TabbedTableSkeleton />
      </div>
    </div>
  );
}
