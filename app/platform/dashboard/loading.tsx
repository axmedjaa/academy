import { Pulse } from "@/app/academy/_shell/ui";

/** Shape-matched skeleton for the P01 dashboard (`dashboard-view.tsx`):
 * header, hero "Total academies" card beside three stacked KPI rows, then
 * chart | pending approvals and expiring subscriptions | recent payments.
 * Same container-query breakpoints as the page, so nothing reflows when the
 * real content streams in. */
const CARD = "rounded-card border border-border bg-surface p-5 shadow-card";

function ListCard({ titleWidth, rows }: { titleWidth: string; rows: number }) {
  return (
    <div className={CARD}>
      <div className="mb-3 flex items-center justify-between">
        <Pulse className={`h-5 ${titleWidth}`} />
        <Pulse className="h-4 w-14" />
      </div>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 border-t border-border py-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <Pulse className="h-3.5 w-1/2" />
            <Pulse className="h-3 w-1/3" />
          </div>
          <Pulse className="h-6 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export default function PlatformDashboardLoading() {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8" role="status" aria-label="Loading dashboard">
      <div className="mb-6 flex flex-col gap-2">
        <Pulse className="h-7 w-36 bg-border" />
        <Pulse className="h-4 w-80 max-w-full bg-border" />
      </div>

      <div className="@container">
        <div className="mb-6 grid grid-cols-1 gap-6 @[720px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="flex min-h-[220px] flex-col justify-between gap-6 rounded-card bg-brand-tint p-7">
            <div className="flex items-start justify-between">
              <Pulse className="h-4 w-28 bg-white/70" />
              <Pulse className="h-10 w-10 rounded-[10px] bg-white/70" />
            </div>
            <div>
              <Pulse className="h-16 w-24 bg-white/70" />
              <div className="mt-5 flex flex-wrap gap-6 border-t border-brand/30 pt-4">
                <Pulse className="h-8 w-32 bg-white/70" />
                <Pulse className="h-8 w-40 bg-white/70" />
              </div>
            </div>
          </div>
          <div className="grid gap-4 @[720px]:grid-rows-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className={`${CARD} flex items-center gap-4 px-5 py-4`}>
                <Pulse className="h-10 w-10 shrink-0 rounded-[10px]" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Pulse className="h-3.5 w-32" />
                  <Pulse className="h-3 w-24" />
                </div>
                <Pulse className="h-7 w-14" />
              </div>
            ))}
          </div>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-6 @[700px]:grid-cols-2">
          <div className={CARD}>
            <div className="mb-4 flex items-start justify-between">
              <div className="flex flex-col gap-1.5">
                <Pulse className="h-5 w-36" />
                <Pulse className="h-3 w-48" />
              </div>
              <Pulse className="h-8 w-10" />
            </div>
            <Pulse className="h-[200px] w-full" />
          </div>
          <ListCard titleWidth="w-36" rows={3} />
        </div>

        <div className="grid grid-cols-1 gap-6 @[700px]:grid-cols-2">
          <ListCard titleWidth="w-44" rows={5} />
          <ListCard titleWidth="w-36" rows={4} />
        </div>
      </div>
    </div>
  );
}
