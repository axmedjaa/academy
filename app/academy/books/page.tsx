import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth/auth-context";
import { getBookCoverUrl, listBooks } from "@/lib/academies/books";
import { searchStudents, STUDENTS_MAX_PAGE_SIZE } from "@/lib/academies/students";
import { PAGE_WRAP, PageHeader, PageMessage } from "@/app/academy/_shell/ui";
import { BooksManager } from "./books-manager";

/**
 * §36-40 — Academy Books catalogue. Gated on `ACADEMY_BOOKS_ACTION`
 * (view-or-above); `listBooks`'s own `canManage` flag decides whether
 * create/edit/sell controls render, same "page always resolves, controls
 * conditionally render" convention as every other `/academy/*` page.
 */
export default async function AcademyBooksPage() {
  const context = await getAuthContext();
  if (!context) {
    redirect("/login");
  }

  const booksResult = await listBooks(context);
  if (!booksResult.ok) {
    return (
      <PageMessage
        title={booksResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={booksResult.error.message}
      />
    );
  }

  const coverUrls = Object.fromEntries(
    await Promise.all(
      booksResult.books
        .filter((book) => book.coverRef)
        .map(async (book) => [book.id, await getBookCoverUrl(book.coverRef)] as const),
    ),
  );

  const studentPickerResult = booksResult.canManage
    ? await searchStudents(context, { status: "active" }, { pageSize: STUDENTS_MAX_PAGE_SIZE })
    : null;
  const studentOptions = studentPickerResult?.ok
    ? studentPickerResult.data.rows.map((row) => ({ id: row.id, fullName: row.fullName, studentNumber: row.studentNumber, phone: row.phone }))
    : [];

  return (
    <div className={PAGE_WRAP}>
      <PageHeader
        title="Books"
        description="The academy's book inventory. Sell to students or walk-in buyers, track stock, and record payments/refunds."
      />
      <BooksManager books={booksResult.books} coverUrls={coverUrls} canManage={booksResult.canManage} studentOptions={studentOptions} />
    </div>
  );
}
