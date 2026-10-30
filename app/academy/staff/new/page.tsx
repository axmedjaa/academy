import { redirect } from "next/navigation";

/**
 * `/academy/staff/new` — kept only so old links and bookmarks keep working:
 * registration happens in the Register staff member dialog on the Staff
 * page, which `?register=1` opens. That page applies the same access checks
 * as before.
 */
export default function NewStaffPage() {
  redirect("/academy/staff?register=1");
}
