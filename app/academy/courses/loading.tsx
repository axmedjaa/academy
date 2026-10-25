import {
  SkeletonHeader,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function CoursesLoading() {
  return (
    <SkeletonPage label="courses">
      <SkeletonHeader title="Courses" description="Courses belong to a program." actions={1} />
      <SkeletonTable headers={["Course", "Program", "Instructor", "Starts", "Ends", "Status"]} stackBelow={900} rows={6} actions />
    </SkeletonPage>
  );
}
