import {
  SkeletonHeader,
  SkeletonPage,
  SkeletonTable,
} from "@/app/academy/_shell/skeletons";

export default function StaffLoading() {
  return (
    <SkeletonPage label="staff">
      <SkeletonHeader title="Staff" description="People who work at this academy. Roles and status are edited on the row; there is no staff detail page." actions={1} />
      <SkeletonTable headers={["Name", "Employee #", "Phone", "Login email", "Role", "Status"]} stackBelow={1040} rows={6} avatar actions />
    </SkeletonPage>
  );
}
