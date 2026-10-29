import { Bone, SkeletonHeader, SkeletonPage, SkeletonTable } from "@/app/academy/_shell/skeletons";

/** Same filter bar as the page (design P07): search, five 44px selects
 * (status, method, academy, plan, date) and Record payment on the right,
 * then the "Showing X of Y" summary line and the table. */
export default function PlatformPaymentsLoading() {
  return (
    <SkeletonPage label="payments">
      <SkeletonHeader title="Payments" description="Subscription payments recorded for academies." />
      <div aria-hidden="true" className="mb-3 flex flex-wrap items-center gap-3">
        <Bone className="h-11 min-w-[200px] max-w-[380px] flex-[1_1_220px] rounded-lg" />
        {["w-[140px]", "w-[140px]", "w-[160px]", "w-[160px]", "w-[140px]"].map((width, index) => (
          <Bone key={index} className={`h-11 ${width} rounded-lg`} />
        ))}
        <span className="hidden flex-1 sm:block" />
        <Bone className="h-11 w-36 rounded-lg" />
      </div>
      <div aria-hidden="true" className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <Bone className="h-3.5 w-40" />
        <Bone className="h-3.5 w-52" />
      </div>
      {/* No Actions column: it only exists for the platform owner. */}
      <SkeletonTable headers={["Payment", "Academy", "Amount", "Method", "Date", "Status"]} rows={8} />
    </SkeletonPage>
  );
}
