import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "academy-design-system";

export function Default() {
  return (
    <DropdownMenu open>
      <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Edit details</DropdownMenuItem>
        <DropdownMenuItem>Suspend academy</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Close academy</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
