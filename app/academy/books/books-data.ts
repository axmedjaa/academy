import { cache } from "react";
import { getAuthContext } from "@/lib/auth/auth-context";
import { listBooks } from "@/lib/academies/books";
import { listBookSales } from "@/lib/academies/book-sales";
import { getPreorderOverview, listPreorderBranchOptions, listPreorderStudentOptions } from "@/lib/academies/book-preorders";

/**
 * The books, sales and pre-orders the Books layout (hero, step bar, tabs)
 * and the open section all read. `cache` makes it one read per request, so
 * a full page load doesn't query twice. Every call keeps its own
 * permission, tenant and branch checks; `null` means signed out.
 */
export const getBooksOverview = cache(async () => {
  const context = await getAuthContext();
  if (!context) return null;
  const [booksResult, salesResult, preordersResult] = await Promise.all([listBooks(context), listBookSales(context), getPreorderOverview(context)]);
  return { context, booksResult, salesResult, preordersResult };
});

/** Active students of the caller's branches, for the order form. */
export const getPreorderStudents = cache(async () => {
  const context = await getAuthContext();
  if (!context) return [];
  const result = await listPreorderStudentOptions(context);
  return result.ok ? result.students : [];
});

/** Active branches of the caller's scope, for an other-person order. */
export const getPreorderBranches = cache(async () => {
  const context = await getAuthContext();
  if (!context) return [];
  const result = await listPreorderBranchOptions(context);
  return result.ok ? result.branches : [];
});
