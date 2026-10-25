import { TableWrap } from "academy-design-system";

const cellStyle = {
  padding: "0.6rem 1rem",
  borderBottom: "1px solid #E2E5EA",
  textAlign: "left" as const,
  fontSize: "0.85rem",
};

export function Default() {
  return (
    <TableWrap>
      <thead>
        <tr>
          <th style={cellStyle}>Name</th>
          <th style={cellStyle}>Branch</th>
          <th style={cellStyle}>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style={cellStyle}>Amina Karim</td>
          <td style={cellStyle}>Main Campus</td>
          <td style={cellStyle}>Active</td>
        </tr>
        <tr>
          <td style={cellStyle}>Yusuf Ali</td>
          <td style={cellStyle}>North Branch</td>
          <td style={cellStyle}>Pending</td>
        </tr>
      </tbody>
    </TableWrap>
  );
}
