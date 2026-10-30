import { Bone } from "@/app/academy/_shell/skeletons";

/**
 * Platform card skeletons (Plans, Usage, Subscriptions), built from the
 * shared Bone so they pulse, and respect reduced motion, the same way as
 * every other page skeleton.
 */
export function SkeletonCardGrid({ count = 6, lines = 5 }: { count?: number; lines?: number }) {
  return (
    <div aria-hidden="true" className="@container mb-8">
      <div className="grid grid-cols-1 gap-5 @[620px]:grid-cols-2 @[940px]:grid-cols-3">
        {Array.from({ length: count }).map((_, i) => (
          <div key={i} className="rounded-card border border-border bg-surface px-5 py-4 shadow-card">
            <Bone className="h-4 w-40" />
            <Bone className="mt-2 h-3 w-28" />
            <div className="mt-4 flex flex-col gap-3.5">
              {Array.from({ length: lines }).map((_, r) => (
                <span key={r} className="flex flex-col gap-1.5">
                  <span className="flex justify-between">
                    <Bone className="h-3 w-16" />
                    <Bone className="h-3 w-12" />
                  </span>
                  <Bone className="h-1.5 w-full rounded-full" />
                </span>
              ))}
            </div>
            <Bone className="mt-5 h-10 w-28 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** One full-width card per row (Subscriptions). */
export function SkeletonRowCards({ count = 5 }: { count?: number }) {
  return (
    <div aria-hidden="true" className="mb-8 flex flex-col gap-3.5">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-card border border-border bg-surface px-5 py-4 shadow-card">
          <span className="flex min-w-[180px] flex-[2_1_180px] flex-col gap-1.5">
            <Bone className="h-4 w-44" />
            <Bone className="h-3 w-32" />
          </span>
          <Bone className="h-4 w-24" />
          <Bone className="h-6 w-20 rounded-full" />
          <Bone className="h-4 w-24" />
          <Bone className="h-10 w-24 rounded-lg" />
        </div>
      ))}
    </div>
  );
}
