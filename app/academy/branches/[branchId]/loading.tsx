import {
  SkeletonDetailHeader,
  SkeletonKv,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function BranchDetailLoading() {
  return (
    <SkeletonPage label="branch">
      <SkeletonDetailHeader backLabel="All branches" actions={1} />
      <SkeletonKv rows={4} />
      <SkeletonTable headers={["Batch", "Courses", "Dates", "Status", "Roster"]} stackBelow={760} rows={4} />
      <SkeletonTable headers={["Course", "Batch", "Days", "Time", "Trainer", "Room"]} stackBelow={760} rows={4} />
    </SkeletonPage>
  );
}
