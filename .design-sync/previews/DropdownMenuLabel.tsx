import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "academy-design-system";

export function Default() {
  return (
    <DropdownMenu open>
      <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Academy actions</DropdownMenuLabel>
        <DropdownMenuItem>Edit details</DropdownMenuItem>
        <DropdownMenuItem>Suspend academy</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem>Close academy</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
