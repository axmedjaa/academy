import { Button, PageHeader } from "academy-design-system";

export function Default() {
  return (
    <PageHeader
      title="Students"
      description="All students enrolled across every branch."
      actions={<Button>Add student</Button>}
    />
  );
}
