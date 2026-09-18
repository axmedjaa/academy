import { SkeletonBlock } from "@/app/academy/_shell/ui";
import { spacing } from "@/lib/ui/theme";

/** DESIGN.md §3.1 "Loading": skeleton rows/cards matching the content
 * shape, never a full-page spinner. Next.js's built-in `loading.tsx`
 * convention (streamed in automatically while the page's async data
 * fetches) — the first use of this convention anywhere in the app. */
export default function DashboardLoading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.xl }}>
      <SkeletonBlock height="2rem" width="12rem" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: spacing.md }}>
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBlock key={i} height="5.5rem" />
        ))}
      </div>
      <SkeletonBlock height="12rem" />
    </div>
  );
}
