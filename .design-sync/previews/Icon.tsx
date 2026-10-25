import { Icon } from "academy-design-system";

export function Default() {
  return (
    <div style={{ display: "flex", gap: "0.75rem", color: "#850019" }}>
      <Icon name="dashboard" width={24} height={24} />
      <Icon name="payments" width={24} height={24} />
      <Icon name="check_circle" width={24} height={24} />
      <Icon name="warning" width={24} height={24} />
    </div>
  );
}
