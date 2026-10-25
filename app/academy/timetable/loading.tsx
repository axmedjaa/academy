import {
  SkeletonHeader,
  SkeletonPage,
  SkeletonPanel,
} from "@/app/academy/_shell/skeletons";

export default function TimetableLoading() {
  return (
    <SkeletonPage label="timetable">
      <SkeletonHeader title="Timetable" description="Weekly schedule across the academy. Saturday first. Session attendance is not part of this product." actions={2} />
      <SkeletonPanel className="h-32" />
      <SkeletonPanel className="h-72" />
      <SkeletonPanel className="h-48" />
    </SkeletonPage>
  );
}
