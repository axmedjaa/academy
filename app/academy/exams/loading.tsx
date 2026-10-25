import {
  SkeletonHeader,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function ExamsLoading() {
  return (
    <SkeletonPage label="exams">
      <SkeletonHeader title="Exams" description="Exams per batch. Enter marks on the exam, then submit them from Results." actions={1} />
      <SkeletonTable headers={["Exam", "Batch", "Max marks", "Date", "Status"]} stackBelow={760} rows={6} actions />
    </SkeletonPage>
  );
}
