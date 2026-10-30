import { SkeletonHeader, SkeletonPage, SkeletonTable } from "@/app/academy/_shell/skeletons";

export default function AcademiesLoading() {
  return (
    <SkeletonPage label="academies">
      <SkeletonHeader title="Academies" description="Every registered academy, with approval and subscription state." actions={1} />
      <SkeletonTable headers={["Academy", "Plan", "Approval", "Subscription", "Branches", "Created"]} rows={8} />
    </SkeletonPage>
  );
}
