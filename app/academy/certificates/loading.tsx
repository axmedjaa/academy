import { SkeletonBlock } from "@/app/academy/_shell/ui";
import { spacing } from "@/lib/ui/theme";

export default function CertificatesLoading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.xl }}>
      <SkeletonBlock height="2rem" width="12rem" />
      <SkeletonBlock height="14rem" />
      <SkeletonBlock height="8rem" />
    </div>
  );
}
