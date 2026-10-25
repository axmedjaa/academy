import {
  SkeletonDetailHeader,
  SkeletonKv,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function BatchDetailLoading() {
  return (
    <SkeletonPage label="batch">
      <SkeletonDetailHeader backLabel="All batches" actions={3} />
      <SkeletonKv rows={5} />
      <SkeletonTable headers={["Trainer", "Assigned", "Status"]} stackBelow={600} rows={2} />
      <SkeletonTable headers={["Student", "Course", "Fee plan", "Overdue", "Enrolled", "Status"]} stackBelow={760} rows={6} actions />
    </SkeletonPage>
  );
}
