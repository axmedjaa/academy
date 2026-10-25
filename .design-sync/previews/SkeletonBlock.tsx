import { SkeletonBlock } from "academy-design-system";

export function Default() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: 240 }}>
      <SkeletonBlock height="1.5rem" width="60%" />
      <SkeletonBlock height="1rem" width="100%" />
      <SkeletonBlock height="1rem" width="80%" />
    </div>
  );
}
