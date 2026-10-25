import {
  SkeletonHeader,
  SkeletonKv,
  SkeletonPage,
  SkeletonPanel,
} from "@/app/academy/_shell/skeletons";

export default function SettingsLoading() {
  return (
    <SkeletonPage label="settings">
      <SkeletonHeader title="Settings" description="Academy profile, usage and notification preferences." actions={1} />
      <SkeletonPanel className="h-[230px] sm:h-40" />
      <SkeletonKv rows={9} />
      <SkeletonKv rows={5} />
      <SkeletonKv rows={14} />
    </SkeletonPage>
  );
}
