import { Button, EmptyState } from "academy-design-system";

export function Default() {
  return <EmptyState message="No students enrolled yet." />;
}

export function WithAction() {
  return <EmptyState message="No branches yet." action={<Button>Add a branch</Button>} />;
}
