import { cache } from "react";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listBooks } from "@/lib/academies/books";
import { listBookSales } from "@/lib/academies/book-sales";
import { getBookOrdersOverview, listBookBranchOptions, listBookStudentOptions } from "@/lib/academies/book-orders";
import { getPreorderOverview } from "@/lib/academies/book-preorders";

/**
 * The books, sales and book orders for a Student or Other Buyer (with
 * payments and books given) the Books
 * layout and the open section all read. `cache` makes it one read per
 * request, so a full page load doesn't query twice. Every call keeps its
 * own permission, tenant and branch checks; `null` means signed out.
 */
export const getBooksOverview = cache(async () => {
  const context = await getAuthContext();
  if (!context) return null;
  const [booksResult, salesResult, ordersResult] = await Promise.all([listBooks(context), listBookSales(context), getBookOrdersOverview(context)]);
  return { context, booksResult, salesResult, ordersResult };
});

/** Old pre-order records (read only), from before Book Management was simplified. */
export const getPreorderHistory = cache(async () => {
  const context = await getAuthContext();
  if (!context) return null;
  return getPreorderOverview(context);
});

/** Active branches of the caller's scope, for an other-person order. */
export const getBookBranches = cache(async () => {
  const context = await getAuthContext();
  if (!context) return [];
  const result = await listBookBranchOptions(context);
  return result.ok ? result.branches : [];
});

/** Active students of the caller's branches, for the sell, order and issue forms. */
export const getBookStudents = cache(async () => {
  const context = await getAuthContext();
  if (!context) return [];
  const result = await listBookStudentOptions(context);
  return result.ok ? result.students : [];
});
