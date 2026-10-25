import { UsageBar } from "academy-design-system";

export function Default() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", width: 260 }}>
      <UsageBar label="Students" used={42} limit={60} />
      <UsageBar label="Branches" used={5} limit={5} />
      <UsageBar label="Staff seats" used={9} limit={10} />
    </div>
  );
}
