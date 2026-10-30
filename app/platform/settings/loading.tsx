import { Bone, SkeletonHeader, SkeletonList, SkeletonPage } from "@/app/academy/_shell/skeletons";

export default function PlatformSettingsLoading() {
  return (
    <SkeletonPage label="settings">
      <SkeletonHeader title="Settings" description="Platform-wide switches." />
      <Bone className="mb-4 h-[72px] w-full rounded-card" />
      <SkeletonList rows={3} avatar={false} />
    </SkeletonPage>
  );
}
