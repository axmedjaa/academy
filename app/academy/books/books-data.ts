import { cache } from "react";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listBooks } from "@/lib/academies/books";
import { listBookSales } from "@/lib/academies/book-sales";

/**
 * The books and sales the Books layout (header and summary cards) and the
 * open tab both read. `cache` makes it one read per request, so a full page
 * load doesn't query twice. Both calls keep their own permission, tenant
 * and scope checks; `null` means signed out.
 */
export const getBooksOverview = cache(async () => {
  const context = await getAuthContext();
  if (!context) return null;
  const [booksResult, salesResult] = await Promise.all([listBooks(context), listBookSales(context)]);
  return { context, booksResult, salesResult };
});
