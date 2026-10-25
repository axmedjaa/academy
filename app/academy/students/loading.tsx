import {
  SkeletonBento,
  SkeletonFilters,
  SkeletonHeader,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function StudentsLoading() {
  return (
    <SkeletonPage label="students">
      <SkeletonHeader title="Students" description actions={2} />
      <SkeletonBento side={3} />
      <SkeletonFilters dropdowns={4} />
      <SkeletonTable headers={["Student", "Batch and plan", "Fees paid", "Payment"]} stackBelow={1040} rows={6} avatar actions />
    </SkeletonPage>
  );
}
