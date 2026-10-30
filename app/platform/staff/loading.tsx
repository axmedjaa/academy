import { SkeletonHeader, SkeletonKv, SkeletonList, SkeletonPage } from "@/app/academy/_shell/skeletons";

export default function PlatformStaffLoading() {
  return (
    <SkeletonPage label="platform staff">
      <SkeletonHeader title="Platform staff" description="Platform Admin accounts and the capabilities each one has been granted." actions={1} />
      <div className="grid grid-cols-1 items-start gap-x-6 lg:grid-cols-2">
        <SkeletonList rows={4} />
        <SkeletonKv rows={7} />
      </div>
    </SkeletonPage>
  );
}
