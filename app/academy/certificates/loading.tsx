import {
  SkeletonChips,
  SkeletonFilters,
  SkeletonHeader,
  SkeletonPage,
  SkeletonPanel,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function CertificatesLoading() {
  return (
    <SkeletonPage label="certificates">
      <SkeletonHeader title="Certificates" description="Verify a certificate by its code, or browse issued certificates. Cancelling is permanent and a cancelled certificate still verifies as cancelled." actions={1} />
      <SkeletonPanel className="h-[248px] sm:h-44" />
      <SkeletonChips count={3} />
      <SkeletonFilters dropdowns={2} />
      <SkeletonTable headers={["Student", "Course", "Batch", "Code", "Issued", "Status"]} stackBelow={900} rows={6} avatar actions />
    </SkeletonPage>
  );
}
