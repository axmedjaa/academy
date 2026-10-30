import { Bone, SkeletonHeader, SkeletonPage } from "@/app/academy/_shell/skeletons";

const CARD = "min-w-0 rounded-card border border-border bg-surface p-5 shadow-card";

/** One report card: title, then label | bar | value rows. */
function ReportCardSkeleton({ rows }: { rows: number }) {
  return (
    <div className={CARD}>
      <Bone className="mb-4 h-4 w-44" />
      {Array.from({ length: rows }).map((_, i) => (
        <span key={i} className="grid grid-cols-[4.75rem_minmax(0,1fr)_2rem] items-center gap-3 border-t border-border py-2.5">
          <Bone className="h-3 w-14" />
          <Bone className="h-2 w-full rounded" />
          <Bone className="h-3 w-6 justify-self-end" />
        </span>
      ))}
    </div>
  );
}

/** Shape of design P09: full-width Revenue card, then one auto-fit grid of
 * the three report cards (same columns as the page, so nothing reflows). */
export default function PlatformReportsLoading() {
  return (
    <SkeletonPage label="reports">
      <SkeletonHeader title="Reports" description="Revenue, academy growth and upcoming expiries." />
      <div aria-hidden="true" className="mb-8 flex flex-col gap-6">
        <div className={CARD}>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <span className="flex flex-col gap-1.5">
              <Bone className="h-4 w-24" />
              <Bone className="h-3 w-72 max-w-full" />
            </span>
            <span className="flex items-end gap-3">
              <Bone className="h-10 w-36 rounded-lg" />
              <Bone className="h-10 w-28 rounded-lg" />
            </span>
          </div>
          <div className="mt-5 flex flex-col gap-4">
            {[0, 1].map((i) => (
              <span key={i} className="grid grid-cols-[6rem_minmax(0,1fr)_7rem] items-center gap-4">
                <Bone className="h-6 w-20" />
                <Bone className="h-[22px] w-full rounded-[11px]" />
                <Bone className="h-8 w-full" />
              </span>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-6">
          <ReportCardSkeleton rows={8} />
          <ReportCardSkeleton rows={5} />
          <ReportCardSkeleton rows={6} />
        </div>
      </div>
    </SkeletonPage>
  );
}
