import { Badge } from "academy-design-system";

export function Tones() {
  return (
    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
      <Badge label="Draft" tone="gray" />
      <Badge label="Pending" tone="amber" />
      <Badge label="Active" tone="green" />
      <Badge label="Suspended" tone="red" />
      <Badge label="Informational" tone="blue" />
      <Badge label="Archived" tone="slate" />
    </div>
  );
}
