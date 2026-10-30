import { SkeletonHeader, SkeletonPage } from "@/app/academy/_shell/skeletons";
import { SkeletonCardGrid } from "../_shared/skeletons";

export default function UsageLoading() {
  return (
    <SkeletonPage label="usage">
      <SkeletonHeader
        title="Usage"
        description="Allowance snapshot per academy. Creating records always checks live allowances, not this snapshot."
      />
      <SkeletonCardGrid count={6} lines={5} />
    </SkeletonPage>
  );
}
