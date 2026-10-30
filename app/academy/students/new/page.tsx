import { redirect } from "next/navigation";

/**
 * `/academy/students/new` — kept only so old links and bookmarks keep
 * working: registration happens in the Register student dialog on the
 * Students page, which `?register=1` opens. That page applies the same
 * access and branch checks as before.
 */
export default function NewStudentPage() {
  redirect("/academy/students?register=1");
}
