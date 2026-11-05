import { SkeletonPage } from "@/app/academy/_shell/skeletons";
import { BooksPageSkeleton } from "./books-skeleton";

/** First load of Book Management: hero, roadmap, tabs and section rows
 * in the shape of the loaded page (design B11). */
export default function BooksLoading() {
  return (
    <SkeletonPage label="Book Management">
      <BooksPageSkeleton />
    </SkeletonPage>
  );
}
