import {
  SkeletonHeader,
  SkeletonKv,
  SkeletonPage,
} from "@/app/academy/_shell/skeletons";

export default function GradesLoading() {
  return (
    <SkeletonPage label="grades">
      <SkeletonHeader title="Grades" description="Grade configurations. One is active at a time. Edit bands while a configuration is a draft; to change an approved or active one, copy it as a draft." actions={1} />
      <SkeletonKv rows={3} />
      <SkeletonKv rows={3} />
    </SkeletonPage>
  );
}
