import { Bone } from "@/app/academy/_shell/skeletons";

/** Shape-matched skeleton for the P01 dashboard (`dashboard-view.tsx`):
 * header, hero "Total academies" card beside three stacked KPI rows, then
 * chart | pending approvals and expiring subscriptions | recent payments.
 * Same container-query breakpoints as the page, so nothing reflows when the
 * real content streams in. Placeholders are the shared neutral bones
 * (design: #EEF0F3 blocks on white cards), never brand-tinted. */
const CARD = "rounded-card border border-border bg-surface p-5 shadow-card";

function ListCard({ titleWidth, rows }: { titleWidth: string; rows: number }) {
  return (
    <div className={CARD}>
      <div className="mb-3 flex items-center justify-between">
        <Bone className={`h-5 ${titleWidth}`} />
        <Bone className="h-4 w-14" />
      </div>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex items-center gap-3 border-t border-border py-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <Bone className="h-3.5 w-1/2" />
            <Bone className="h-3 w-1/3" />
          </div>
          <Bone className="h-6 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export default function PlatformDashboardLoading() {
  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading dashboard…</span>
      <div className="mb-6 flex flex-col gap-2">
        <Bone className="h-7 w-36" />
        <Bone className="h-4 w-80 max-w-full" />
      </div>

      <div className="@container">
        <div className="mb-6 grid grid-cols-1 gap-6 @[720px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="flex min-h-[220px] flex-col justify-between gap-6 rounded-card border border-border bg-surface p-7 shadow-card">
            <div className="flex items-start justify-between">
              <Bone className="h-4 w-28" />
              <Bone className="h-10 w-10 rounded-[10px]" />
            </div>
            <div>
              <Bone className="h-16 w-24" />
              <div className="mt-5 flex flex-wrap gap-6 border-t border-border pt-4">
                <Bone className="h-8 w-32" />
                <Bone className="h-8 w-40" />
              </div>
            </div>
          </div>
          <div className="grid gap-4 @[720px]:grid-rows-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className={`${CARD} flex items-center gap-4 px-5 py-4`}>
                <Bone className="h-10 w-10 shrink-0 rounded-[10px]" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <Bone className="h-3.5 w-32" />
                  <Bone className="h-3 w-24" />
                </div>
                <Bone className="h-7 w-14" />
              </div>
            ))}
          </div>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-6 @[700px]:grid-cols-2">
          <div className={CARD}>
            <div className="mb-4 flex items-start justify-between">
              <div className="flex flex-col gap-1.5">
                <Bone className="h-5 w-36" />
                <Bone className="h-3 w-48" />
              </div>
              <Bone className="h-8 w-10" />
            </div>
            <Bone className="h-[200px] w-full" />
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
