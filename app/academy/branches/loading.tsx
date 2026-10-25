import {
  SkeletonHeader,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function BranchesLoading() {
  return (
    <SkeletonPage label="branches">
      <SkeletonHeader title="Branches" description actions={1} />
      <SkeletonTable headers={["Name", "Code", "Status", "Address", "Phone"]} stackBelow={900} rows={6} actions />
    </SkeletonPage>
  );
}
