import {
  SkeletonFilters,
  SkeletonHeader,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function AdmissionsLoading() {
  return (
    <SkeletonPage label="admissions">
      <SkeletonHeader title="Admissions" description="Active students who are not enrolled in a batch yet. Enrolling moves them off this list." actions={1} />
      <SkeletonFilters search={false} dropdowns={1} />
      <SkeletonTable headers={["Student", "Stage", "Registered"]} stackBelow={600} rows={6} avatar actions />
    </SkeletonPage>
  );
}
