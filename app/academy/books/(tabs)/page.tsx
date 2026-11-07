import Link from "next/link";
import { redirect } from "next/navigation";
import { PageMessage } from "@/app/academy/_shell/ui";
import { FilterSelect, SearchField } from "@/app/academy/_shell/filter-controls";
import { getBooksOverview } from "../books-data";
import { GatedAction, BookCard, ToggleParam } from "../books-sections";
import { BTN_SECONDARY, EmptyCard, Pager, paginate, readParams } from "../books-ui";
import { plural } from "../books-view";

const PAGE_SIZE = 6;

/**
 * Books (design B01, step 1): the catalogue as cards with cover, subject
 * and class, current selling price, stock for sale and the campaign the
 * book is in; Sell Book, View, Edit and Archive / Restore. Filters are URL
 * params over the scoped `listBooks` result. Archiving keeps the book on
 * existing sales and orders; it only stops new sales and new campaigns.
 */
export default async function AcademyBooksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const overview = await getBooksOverview();
  if (!overview) redirect("/login");
  const { booksResult } = overview;
  if (!booksResult.ok) {
    return <PageMessage title={booksResult.error.code === "blocked" ? "Access unavailable" : "Access denied"} message={booksResult.error.message} />;
  }
  const params = await searchParams;
  const { get, page } = readParams(params);
  const q = get("q").toLowerCase();
  const subject = get("subject");
  const cls = get("class");
  const showArchived = get("archived") === "1";

  const all = booksResult.books;
  const subjects = [...new Set(all.map((b) => b.subject).filter((v): v is string => Boolean(v)))].sort();
  const classes = [...new Set(all.map((b) => b.classLevel).filter((v): v is string => Boolean(v)))].sort();
  const rows = all
    .filter((b) => showArchived || b.status === "active")
    .filter((b) => !subject || b.subject === subject)
    .filter((b) => !cls || b.classLevel === cls)
    .filter((b) => !q || [b.name, b.subject ?? "", b.author ?? "", b.isbn ?? ""].some((f) => f.toLowerCase().includes(q)))
    .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : a.status === "active" ? -1 : 1));
  const visible = paginate(rows, page, PAGE_SIZE);

  return (
    <>
      {all.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <SearchField placeholder="Search title or subject" />
          {subjects.length > 0 && <FilterSelect param="subject" label="Subject" options={[{ value: "", label: "All subjects" }, ...subjects.map((s) => ({ value: s, label: s }))]} />}
          {classes.length > 0 && <FilterSelect param="class" label="Class" options={[{ value: "", label: "All classes" }, ...classes.map((s) => ({ value: s, label: s }))]} />}
          <ToggleParam param="archived" label="Show archived" />
          <span className="text-[13px] text-muted">
            {plural(rows.length, "book", "books")}
            {showArchived ? ", including archived" : ""}
          </span>
        </div>
      )}

      {visible.length === 0 ? (
        all.length === 0 ? (
          <EmptyCard
            title="No books in the catalog"
            description="Add the first book to start selling and building pre-order campaigns."
            action={
              <GatedAction need="canManageBooks" dialog={{ kind: "addBook" }} variant="secondary">
                Add book
              </GatedAction>
            }
          />
        ) : (
          <EmptyCard
            title="No books match"
            description="Try a different search or clear the filters."
            action={
              <Link href="/academy/books" className={BTN_SECONDARY}>
                Clear filters
              </Link>
            }
          />
        )
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-4">
          {visible.map((book) => (
            <BookCard key={book.id} book={book} />
          ))}
        </div>
      )}
      <div className="mt-4">
        <Pager page={page} pageSize={PAGE_SIZE} total={rows.length} params={params} />
      </div>
    </>
  );
}
