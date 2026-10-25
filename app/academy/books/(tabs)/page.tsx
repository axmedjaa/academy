import Link from "next/link";
import { redirect } from "next/navigation";
import { getBookCoverUrl } from "@/lib/academies/books";
import { searchStudents, STUDENTS_MAX_PAGE_SIZE } from "@/lib/academies/students";
import { EmptyState, PageMessage, Section } from "@/app/academy/_shell/ui";
import { NoteBlock } from "@/app/academy/_shell/page-blocks";
import { FilterBar, SearchField } from "@/app/academy/_shell/filter-controls";
import { Icon } from "@/app/academy/_shell/icons";
import { getBooksOverview } from "../books-data";
import { AddBookButton, BookCard } from "../books-client";

/**
 * Books catalogue (design A16, Catalogue tab): the stock and sales bento,
 * search by title, ISBN or author, and a card per book with its cover,
 * price and stock, plus Sell, Activate / Deactivate and cover upload for
 * roles that manage books (`listBooks`'s own `canManage`).
 */
export default async function AcademyBooksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Same cached read as the Books layout above (one query per request).
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { context, booksResult } = overview;
  if (!booksResult.ok) {
    return (
      <PageMessage
        title={booksResult.error.code === "blocked" ? "Access unavailable" : "Access denied"}
        message={booksResult.error.message}
      />
    );
  }
  const params = await searchParams;
  const q = (Array.isArray(params.q) ? params.q[0] : params.q)?.trim().toLowerCase() ?? "";
  const books = [...booksResult.books].sort(
    (a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "active" ? -1 : 1),
  );
  const visible = q
    ? books.filter((book) => [book.name, book.isbn ?? "", book.author ?? ""].some((field) => field.toLowerCase().includes(q)))
    : books;

  const [coverEntries, studentsResult] = await Promise.all([
    Promise.all(visible.filter((book) => book.coverRef).map(async (book) => [book.id, await getBookCoverUrl(book.coverRef)] as const)),
    booksResult.canManage ? searchStudents(context, { status: "active" }, { pageSize: STUDENTS_MAX_PAGE_SIZE }) : Promise.resolve(null),
  ]);
  const coverUrls = Object.fromEntries(coverEntries);
  const studentOptions = studentsResult?.ok
    ? studentsResult.data.rows.map((row) => ({ id: row.id, fullName: row.fullName, studentNumber: row.studentNumber, phone: row.phone }))
    : [];

  return (
    <>
      {booksResult.books.length > 0 && (
        <FilterBar>
          <SearchField placeholder="Search name, ISBN or author" />
        </FilterBar>
      )}

      {visible.length === 0 ? (
        <Section className="mb-8">
          {booksResult.books.length > 0 ? (
            <EmptyState
              message={`No book matches "${q}". Search looks at the name, ISBN and author.`}
              icon={<Icon name="book" />}
              action={
                <Link href="/academy/books" className="inline-flex min-h-11 items-center rounded-lg border border-border-strong bg-surface px-4 text-sm font-semibold !text-ink no-underline hover:bg-app hover:no-underline">
                  Clear search
                </Link>
              }
            />
          ) : booksResult.canManage ? (
            <EmptyState
              message="No books yet. Add the first title with its cover, price and copies in stock, then sell it from its card."
              icon={<Icon name="book" />}
              action={<AddBookButton />}
            />
          ) : (
            <EmptyState message="No books yet. Staff who manage books add titles here." icon={<Icon name="book" />} />
          )}
        </Section>
      ) : (
        <div className="@container mb-8">
          <div className="grid grid-cols-1 gap-5 @[560px]:grid-cols-2 @[880px]:grid-cols-3">
            {visible.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                coverUrl={coverUrls[book.id] ?? null}
                canManage={booksResult.canManage}
                studentOptions={studentOptions}
              />
            ))}
          </div>
        </div>
      )}

      <NoteBlock>
        Initials show until a book has a cover. A book is changed only by activating or deactivating it and by its cover;
        stock changes through sales and refunds. Book sale payments are cash or mobile money only.
      </NoteBlock>
    </>
  );
}
