import { Bone, SkeletonHeader, SkeletonPage } from "@/app/academy/_shell/skeletons";

const PANEL = "rounded-[20px] border border-[#E5E7EB] bg-surface p-6";

/** Dashboard: the real title, then the KPI bento, the payments strip, the
 * two activity panels and the two chart panels, in neutral placeholders. */
export default function DashboardLoading() {
  return (
    <SkeletonPage label="dashboard" wrap="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <SkeletonHeader title="Dashboard" description actions={1} />

      <div className="@container" aria-hidden="true">
        <div className="mb-8 grid grid-cols-1 gap-6 @[480px]:grid-cols-2 @[860px]:grid-cols-3">
          <div className="flex min-h-[200px] flex-col justify-between rounded-[20px] border border-[#E5E7EB] bg-surface p-7 @[480px]:col-span-2 @[860px]:col-span-1 @[860px]:row-span-2">
            <span className="flex items-center gap-3">
              <Bone className="h-12 w-12 rounded-[14px]" />
              <Bone className="h-4 w-28" />
            </span>
            <span>
              <Bone className="h-16 w-32" />
              <Bone className="mt-3 h-4 w-20" />
            </span>
          </div>
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex min-h-[196px] flex-col justify-between rounded-[20px] border border-[#E5E7EB] bg-surface p-[22px]">
              <Bone className="h-[46px] w-[46px] rounded-[14px]" />
              <span className="flex flex-col gap-2">
                <Bone className="h-9 w-20" />
                <Bone className="h-3.5 w-28" />
                <Bone className="h-3 w-32" />
              </span>
            </div>
          ))}
          <div className="flex min-h-[140px] items-center gap-4 rounded-2xl border border-[#E5E7EB] bg-surface px-6 @[480px]:col-span-2 @[480px]:min-h-[96px] @[860px]:col-span-3">
            <Bone className="h-12 w-12 rounded-xl" />
            <span className="flex flex-1 flex-col gap-2">
              <Bone className="h-4 w-40" />
              <Bone className="h-3 w-28" />
            </span>
            <Bone className="h-9 w-28" />
          </div>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-6 @[760px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          {[3, 4].map((rows, panel) => (
            <div key={panel} className={PANEL}>
              <Bone className="mb-5 h-5 w-40" />
              <div className="flex flex-col gap-5">
                {Array.from({ length: rows }).map((_, index) => (
                  <span key={index} className="flex items-center gap-3">
                    <Bone className="h-10 w-10 shrink-0 rounded-full" />
                    <span className="flex flex-1 flex-col gap-1.5">
                      <Bone className="h-3.5 w-1/2" />
                      <Bone className="h-3 w-1/3" />
                    </span>
                    <Bone className="h-8 w-20 rounded-lg" />
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-6 @[700px]:grid-cols-2">
          <div className={PANEL}>
            <Bone className="mb-4 h-5 w-32" />
            <Bone className="h-[240px] w-full rounded-lg" />
          </div>
          <div className={PANEL}>
            <Bone className="mb-5 h-5 w-44" />
            <div className="flex flex-col gap-5">
              {Array.from({ length: 5 }).map((_, index) => (
                <span key={index} className="flex flex-col gap-2">
                  <Bone className="h-3 w-24" />
                  <Bone className="h-1.5 w-full rounded-full" />
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </SkeletonPage>
  );
}
