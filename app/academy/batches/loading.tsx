import {
  SkeletonHeader,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function BatchesLoading() {
  return (
    <SkeletonPage label="batches">
      <SkeletonHeader title="Batches" description="Cohorts at one branch. A batch can run one course or several." actions={1} />
      <SkeletonTable headers={["Batch", "Courses", "Branch", "Starts", "Status", "Roster"]} stackBelow={900} rows={6} actions />
    </SkeletonPage>
  );
}
