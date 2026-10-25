import { Toolbar } from "academy-design-system";

export function Default() {
  return (
    <Toolbar>
      <input
        placeholder="Search students..."
        style={{ padding: "0.5rem 0.75rem", border: "1px solid #E2E5EA", borderRadius: 8, minWidth: 220 }}
      />
      <select style={{ padding: "0.5rem 0.75rem", border: "1px solid #E2E5EA", borderRadius: 8 }}>
        <option>All branches</option>
        <option>Main Campus</option>
      </select>
    </Toolbar>
  );
}
