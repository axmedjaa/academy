import {
  SkeletonDetailHeader,
  SkeletonKv,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function CourseDetailLoading() {
  return (
    <SkeletonPage label="course">
      <SkeletonDetailHeader backLabel="All courses" actions={1} />
      <SkeletonKv rows={5} />
      <SkeletonTable headers={["Student", "Batch", "Status"]} stackBelow={600} rows={6} avatar />
    </SkeletonPage>
  );
}
