import {
  Bone,
  SkeletonDetailHeader,
  SkeletonKv,
  SkeletonPage,
  SkeletonPanel,
  SkeletonTable,
  SkeletonTabs,
} from "@/app/academy/_shell/skeletons";

export default function StudentDetailLoading() {
  return (
    <SkeletonPage label="student">
      <SkeletonDetailHeader backLabel="All students" actions={2} />
      <SkeletonTabs labels={["Overview", "Fees", "Payments"]} />
      <SkeletonPanel className="h-[184px] sm:h-40" />
      <SkeletonKv rows={10} />
      <SkeletonPanel className="h-32" />
      {/* Enrolled courses (design A02 columns); Past courses only appears when there are any. */}
      <Bone className="mb-3 h-5 w-40" />
      <SkeletonTable headers={["Course", "Batch", "Schedule", "Trainer", "Fees paid", "Status"]} rows={2} />
    </SkeletonPage>
  );
}
