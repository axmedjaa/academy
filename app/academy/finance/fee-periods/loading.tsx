import {
  SkeletonChips,
  SkeletonFilters,
  SkeletonHeader,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function FeePeriodsLoading() {
  return (
    <SkeletonPage label="fee periods">
      <SkeletonHeader title="Fee periods" description="Installment schedules for enrolled students." />
      <SkeletonChips count={5} />
      <SkeletonFilters />
      <SkeletonTable headers={["Student", "Batch", "Schedule", "Due so far", "Paid", "Remaining", "Status"]} stackBelow={1040} rows={6} actions />
    </SkeletonPage>
  );
}
