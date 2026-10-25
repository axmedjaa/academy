import {
  SkeletonDetailHeader,
  SkeletonKv,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function ExamDetailLoading() {
  return (
    <SkeletonPage label="exam">
      <SkeletonDetailHeader backLabel="All exams" actions={1} />
      <SkeletonKv rows={4} />
      <SkeletonTable headers={["Student", "ID", "Mark", "Grade", "Result"]} stackBelow={600} rows={8} avatar />
    </SkeletonPage>
  );
}
