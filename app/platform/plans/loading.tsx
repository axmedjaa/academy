import { Bone, SkeletonHeader, SkeletonPage } from "@/app/academy/_shell/skeletons";

/** One plan card's shape (plans-manager.tsx PlanCard): name and status
 * badge, the large price line, five allowance rows, a feature chip and the
 * Edit / Retire pair. */
function PlanCardSkeleton() {
  return (
    <div className="flex min-w-0 flex-col rounded-card border border-border bg-surface p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Bone className="h-4 w-4/5" />
          <Bone className="h-4 w-1/2" />
        </span>
        <Bone className="h-6 w-16 rounded-full" />
      </div>
      <span className="mt-3 flex items-end gap-2">
        <Bone className="h-8 w-28" />
        <Bone className="h-3.5 w-16" />
      </span>
      <div className="mt-4 divide-y divide-border border-y border-border">
        {[0, 1, 2, 3, 4].map((row) => (
          <span key={row} className="flex items-center justify-between gap-3 py-3">
            <Bone className="h-3.5 w-20" />
            <Bone className="h-3.5 w-10" />
          </span>
        ))}
      </div>
      <Bone className="mt-3 h-5 w-24 rounded-full" />
      <span className="mt-4 flex gap-2">
        <Bone className="h-10 flex-1 rounded-lg" />
        <Bone className="h-10 flex-1 rounded-lg" />
      </span>
    </div>
  );
}

/** Same structure as the page (design P06): header with Create plan, the
 * search / status / price filter bar, the "Showing X of Y plans" line, then
 * the card grid with the page's own columns. */
export default function PlansLoading() {
  return (
    <SkeletonPage label="plans">
      <SkeletonHeader
        title="Plans"
        description="Pricing and allowances. Retired plans stay on existing subscriptions and cannot be chosen for new ones."
        actions={1}
      />
      <div aria-hidden="true">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Bone className="h-11 min-w-[200px] max-w-[380px] flex-[1_1_220px] rounded-lg" />
          <Bone className="h-11 w-[140px] rounded-lg" />
          <Bone className="h-11 w-[150px] rounded-lg" />
        </div>
        {/* Same line box as the 13px "Showing X of Y plans" text. */}
        <div className="mb-3 flex h-5 items-center">
          <Bone className="h-3.5 w-36" />
        </div>
        <div className="mb-8 grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-6">
          {[0, 1, 2, 3, 4, 5].map((card) => (
            <PlanCardSkeleton key={card} />
          ))}
        </div>
      </div>
    </SkeletonPage>
  );
}
