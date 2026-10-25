import {
  SkeletonHeader,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function ProgramsLoading() {
  return (
    <SkeletonPage label="programs">
      <SkeletonHeader title="Programs" description="Groups of related courses." actions={1} />
      <SkeletonTable headers={["Program", "Description", "Courses", "Status"]} stackBelow={760} rows={6} actions />
    </SkeletonPage>
  );
}
