import {
  Bone,
  SkeletonDetailHeader,
  SkeletonKv,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

/** While a batch loads: breadcrumb and header, the enrollment notice, the
 * Batch card, then the Trainers and Enrolled students tables. */
export default function BatchDetailLoading() {
  return (
    <SkeletonPage label="batch">
      <SkeletonDetailHeader backLabel="Batches" actions={3} />
      <Bone className="mb-6 h-12 w-full rounded-card" />
      <SkeletonKv rows={5} />
      <SkeletonTable headers={["Trainer", "Assigned", "Status"]} stackBelow={600} rows={2} />
      <SkeletonTable headers={["Student", "Course", "Fee plan", "Overdue", "Enrolled", "Status"]} stackBelow={760} rows={6} actions />
    </SkeletonPage>
  );
}
