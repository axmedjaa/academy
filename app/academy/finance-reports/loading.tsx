import { SkeletonBlock } from "@/app/academy/_shell/ui";
import { spacing } from "@/lib/ui/theme";

export default function FinanceReportsLoading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.xl }}>
      <SkeletonBlock height="2rem" width="12rem" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: spacing.md }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonBlock key={i} height="5.5rem" />
        ))}
      </div>
      <SkeletonBlock height="12rem" />
    </div>
  );
}
