import { SkeletonPage } from "@/app/academy/_shell/skeletons";
import { BooksRouteSkeleton } from "./books-route-skeleton";

/** First load of Book Management (design B11): the hero, the real tabs and
 * pills with the opened section marked, and that section's own skeleton. */
export default function BooksLoading() {
  return (
    <SkeletonPage label="Book Management">
      <BooksRouteSkeleton />
    </SkeletonPage>
  );
}
