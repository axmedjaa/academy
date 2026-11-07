
import { Bone, SkeletonTable } from "@/app/academy/_shell/skeletons";

/**
 * Book Management loading states (design B11). Same look as every other
 * Academy page's skeleton: the shared neutral grey bone (`Bone` from
 * app/academy/_shell/skeletons, #EEF0F3, pulsing only when motion is
 * allowed) on white cards, with the page's real title. The full-page
 * skeleton follows the loaded layout (hero with its three actions, the
 * Books / Orders tabs and section pills); each section then has its own
 * skeleton in the shape of what it loads (book cards, campaign cards, order
 * rows, summary cards, history rows), so nothing jumps when content arrives.
 */

const card = "rounded-2xl border border-border bg-surface shadow-card";

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

function Head({ action = false }: { action?: boolean }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <Bone className="h-6 w-48 rounded-md" />
        <Bone className="mt-2 h-4 w-[340px] max-w-[80vw] rounded-md" />
      </div>
      {action && <Bone className="h-11 w-36 rounded-lg" />}
    </div>
  );
}

function Filters({ selects = 1, chips = 0 }: { selects?: number; chips?: number }) {
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-3">
        <Bone className="h-11 w-full max-w-[380px] rounded-lg" />
        {Array.from({ length: selects }, (_, i) => (
          <Bone key={i} className="h-11 w-40 rounded-lg" />
        ))}
      </div>
      {chips > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {Array.from({ length: chips }, (_, i) => (
            <Bone key={i} className="h-10 w-28 rounded-full" />
          ))}
        </div>
      )}
    </>
  );
}

function Kpis({ count = 3 }: { count?: number }) {
  return (
    <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))] sm:gap-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`${card} px-5 py-4`}>
          <Bone className="h-3.5 w-24 rounded" />
          <Bone className="mt-3 h-7 w-20 rounded-md" />
        </div>
      ))}
    </div>
  );
}

function Note() {
  return <Bone className="mb-4 h-14 rounded-xl" />;
}

function HistoryRows({ rows = 3 }: { rows?: number }) {
  return (
    <>
      <Bone className="mt-8 h-5 w-40 rounded" />
      <Bone className="mb-3 mt-1.5 h-3.5 w-56 rounded" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className={`${card} flex items-center gap-6 px-4 py-3`}>
            <Bone className="h-8 w-20 rounded" />
            <Bone className="h-8 flex-1 rounded" />
            <Bone className="hidden h-8 w-16 rounded sm:block" />
            <Bone className="hidden h-4 w-24 rounded md:block" />
          </div>
        ))}
      </div>
    </>
  );
}

function OrderCards({ count = 3 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`${card} relative mb-3 overflow-hidden`}>
          <div className="absolute inset-y-0 left-0 w-[5px] bg-border" />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 py-4 pl-[25px] pr-5">
            <div className="flex min-w-0 flex-[1_1_200px] items-center gap-3.5">
              <Bone className="h-11 w-11 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <Bone className="h-4 w-36 max-w-full rounded" />
                <Bone className="mt-1.5 h-3 w-44 max-w-full rounded" />
              </div>
            </div>
            <div className="grid min-w-0 flex-[0_1_300px] grid-cols-3 gap-3 max-sm:flex-[1_1_100%]">
              {[0, 1, 2].map((j) => (
                <div key={j}>
                  <Bone className="h-3 w-10 rounded" />
                  <Bone className="mt-1.5 h-5 w-16 rounded" />
                </div>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-2.5 max-sm:ml-0">
              <Bone className="h-6 w-20 rounded-full" />
              <Bone className="h-11 w-16 rounded-lg" />
              <Bone className="h-11 w-36 rounded-lg" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Sections                                                            */
/* ------------------------------------------------------------------ */

/** Books: filters and the book-card grid. */
export function BooksCatalogSkeleton() {
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Bone className="h-11 w-full max-w-[380px] rounded-lg" />
        <Bone className="h-11 w-36 rounded-lg" />
        <Bone className="h-11 w-32 rounded-lg" />
        <Bone className="h-11 w-36 rounded-lg" />
        <Bone className="h-3.5 w-14 rounded" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-4">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className={`${card} flex flex-col overflow-hidden`}>
            <div className="flex h-[164px] items-center justify-center bg-app">
              <Bone className="h-[132px] w-24 rounded-md" />
            </div>
            <div className="px-4 pb-3.5 pt-4">
              <Bone className="h-4 w-4/5 rounded" />
              <Bone className="mt-2 h-3 w-1/2 rounded" />
              <div className="mt-3 flex items-center justify-between gap-3">
                <Bone className="h-6 w-16 rounded" />
                <Bone className="h-3.5 w-20 rounded" />
              </div>
            </div>
            <div className="mt-auto flex items-center gap-3 border-t border-border px-3 py-3">
              <Bone className="mr-auto h-11 w-24 rounded-lg" />
              <Bone className="h-4 w-10 rounded" />
              <Bone className="h-4 w-8 rounded" />
              <Bone className="h-4 w-14 rounded" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export function SellSkeleton() {
  return (
    <>
      <Head />
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {["sell", "pre-order"].map((key) => (
          <div key={key} className={`${card} flex flex-col gap-3 p-5`}>
            <div className="flex items-center gap-3">
              <Bone className="h-10 w-10 rounded-xl" />
              <Bone className="h-5 w-32 rounded" />
            </div>
            <Bone className="h-3.5 w-full rounded" />
            <Bone className="h-3.5 w-4/5 rounded" />
            <Bone className="h-11 w-36 rounded-lg" />
          </div>
        ))}
      </div>
      <Bone className="mb-3 h-5 w-28 rounded" />
      <Bone className="mb-4 h-11 w-full max-w-[420px] rounded-lg" />
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className={`${card} flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-4`}>
            <div className="flex-[1_1_230px]">
              <Bone className="h-4 w-40 rounded" />
              <Bone className="mt-2 h-3 w-48 rounded" />
            </div>
            <div className="flex-[1_1_190px]">
              <Bone className="h-3 w-12 rounded" />
              <Bone className="mt-2 h-4 w-32 rounded" />
            </div>
            <div className="grid flex-[2_1_300px] grid-cols-3 gap-3">
              {[0, 1, 2].map((j) => (
                <Bone key={j} className="h-9 rounded" />
              ))}
            </div>
            <Bone className="h-10 w-36 rounded-lg" />
          </div>
        ))}
      </div>
    </>
  );
}

/** Pre-Orders: campaign cards, two across. */
export function CampaignsSkeleton() {
  return (
    <>
      <Head />
      <Filters />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${card} flex flex-col gap-4 p-5`}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <Bone className="h-5 w-40 rounded" />
                <Bone className="mt-2 h-3 w-16 rounded" />
              </div>
              <Bone className="h-6 w-20 rounded-full" />
            </div>
            <div>
              <Bone className="h-2 w-full rounded" />
              <Bone className="mt-2 h-3.5 w-28 rounded" />
            </div>
            <div className="grid grid-cols-3 gap-3 border-y border-border py-3">
              {[0, 1, 2].map((j) => (
                <Bone key={j} className="h-9 rounded" />
              ))}
            </div>
            <div className="flex flex-col gap-2.5">
              {[0, 1, 2].map((j) => (
                <Bone key={j} className="h-6 rounded" />
              ))}
            </div>
            <div className="flex gap-2">
              <Bone className="h-11 flex-1 rounded-lg" />
              <Bone className="h-11 flex-1 rounded-lg" />
              <Bone className="h-11 flex-1 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Student Orders: how-to steps, KPIs, filters and order cards. */
export function OrdersSkeleton() {
  return (
    <>
      <Head />
      <Kpis count={3} />
      <Filters chips={4} />
      <OrderCards />
    </>
  );
}

/** Payments: steps, three KPIs, the two views and order cards. */
export function PaymentsSkeleton() {
  return (
    <>
      <Head />
      <Kpis count={3} />
      <Bone className="mb-4 h-12 w-80 max-w-full rounded-xl" />
      <Bone className="mb-3 h-11 w-full max-w-[380px] rounded-lg" />
      <OrderCards count={2} />
    </>
  );
}

/** Receive Books: note, campaign picker, KPIs, book cards and history. */
export function ReceivingSkeleton() {
  return (
    <>
      <Head />
      <Note />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Bone className="h-4 w-16 rounded" />
        <Bone className="h-11 w-48 rounded-lg" />
        <Bone className="h-3.5 w-72 max-w-full rounded" />
      </div>
      <Kpis count={4} />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,230px),1fr))] gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className={`${card} flex flex-col gap-3 p-4`}>
            <div className="flex items-center gap-3">
              <Bone className="h-[46px] w-[38px] rounded-md" />
              <div className="flex-1">
                <Bone className="h-4 w-4/5 rounded" />
                <Bone className="mt-1.5 h-3 w-1/2 rounded" />
              </div>
            </div>
            <Bone className="h-6 w-full rounded-full" />
            <Bone className="h-2 w-full rounded" />
            <div className="grid grid-cols-4 gap-2">
              {[0, 1, 2, 3].map((j) => (
                <Bone key={j} className="h-9 rounded" />
              ))}
            </div>
            <Bone className="h-11 w-full rounded-lg" />
          </div>
        ))}
      </div>
      <HistoryRows />
    </>
  );
}

/** Give Books: note, steps, KPIs, filters, order rows and history. */
export function GiveSkeleton() {
  return (
    <>
      <Head />
      <Note />
      <Kpis count={3} />
      <Filters chips={5} />
      {[0, 1, 2].map((i) => (
        <div key={i} className={`${card} mb-3 grid grid-cols-1 items-center gap-4 p-4 md:grid-cols-[2.2fr_1.6fr_auto] md:px-5`}>
          <div className="flex items-center gap-3">
            <Bone className="h-11 w-11 rounded-full" />
            <div>
              <Bone className="h-4 w-36 rounded" />
              <Bone className="mt-1.5 h-3 w-44 rounded" />
            </div>
          </div>
          <div>
            <Bone className="h-4 w-32 rounded" />
            <Bone className="mt-2 h-6 w-44 rounded-full" />
          </div>
          <Bone className="h-11 w-28 rounded-lg" />
        </div>
      ))}
      <HistoryRows />
    </>
  );
}

/** Reports: KPIs and the two summary tables. */
export function ReportsSkeleton() {
  return (
    <>
      <Head />
      <Bone className="mb-4 h-11 w-48 rounded-lg" />
      <Kpis count={6} />
      {[0, 1].map((t) => (
        <div key={t} className="mb-6">
          <Bone className="mb-2 h-5 w-40 rounded" />
          <div className={`${card} overflow-hidden`}>
            <div className="h-10 border-b border-border bg-app" />
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`flex gap-6 px-4 py-3 ${i ? "border-t border-border" : ""}`}>
                <Bone className="h-4 flex-[2] rounded" />
                <Bone className="h-4 flex-1 rounded" />
                <Bone className="h-4 flex-1 rounded" />
                <Bone className="h-4 flex-1 rounded" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** Order details: back link, title, badges, KPIs, books, payments, history. */
export function OrderDetailSkeleton() {
  return (
    <>
      <Bone className="mb-4 h-5 w-32 rounded" />
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <Bone className="h-7 w-44 rounded-md" />
          <Bone className="mt-2 h-4 w-72 max-w-[80vw] rounded" />
        </div>
        <Bone className="h-11 w-40 rounded-lg" />
      </div>
      <div className="mb-4 flex gap-2">
        <Bone className="h-6 w-24 rounded-full" />
        <Bone className="h-6 w-28 rounded-full" />
      </div>
      <Kpis count={4} />
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-4">
          {[0, 1].map((s) => (
            <div key={s} className={`${card} overflow-hidden`}>
              <Bone className="m-4 h-5 w-40 rounded" />
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 border-t border-border px-4 py-3">
                  <Bone className="h-12 w-9 rounded" />
                  <Bone className="h-4 flex-1 rounded" />
                  <Bone className="h-4 w-16 rounded" />
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className={`${card} p-4`}>
          <Bone className="mb-3 h-5 w-20 rounded" />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="mb-3 flex gap-3">
              <Bone className="mt-1 h-2.5 w-2.5 rounded-full" />
              <div className="flex-1">
                <Bone className="h-3.5 w-full rounded" />
                <Bone className="mt-1.5 h-3 w-2/3 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** The page hero while loading: real title and description, outlines of
 * the three main actions. Neutral, like every Academy page skeleton. */
export function BooksHeroSkeleton() {
  return (
    <div className={`${card} mb-7 rounded-[20px] p-[22px] sm:px-8 sm:pb-8 sm:pt-9`}>
      <div className="text-[28px] font-bold leading-[1.1] tracking-[-0.02em] text-ink sm:text-[36px]">Book Management</div>
      <p className="mt-3 max-w-[60ch] leading-normal text-muted">Manage academy books, pre-orders, payments and distribution.</p>
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-3.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex min-h-[74px] items-center gap-3.5 rounded-[14px] border border-border px-4 py-3.5">
            <Bone className="h-11 w-11 shrink-0 rounded-[10px]" />
            <div className="min-w-0 flex-1">
              <Bone className="h-4 w-24 rounded" />
              <Bone className="mt-1.5 h-3 w-40 max-w-full rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** An order's own page shows this compact title instead of the hero (B05). */
export function BooksCompactTitle() {
  return (
    <div className="mb-5">
      <div className="text-[28px] font-bold leading-tight tracking-[-0.015em]">Book Management</div>
      <p className="mt-1.5 text-muted">Manage academy books, pre-orders, payments and distribution.</p>
    </div>
  );
}

/** Reports link and section action while loading (they depend on access). */
export function NavRightSkeleton() {
  return (
    <>
      <Bone className="h-5 w-20 rounded" />
      <Bone className="h-11 w-32 rounded-lg" />
    </>
  );
}

/** Stock: level chips, search, and the stock table (Book, Price, In stock,
 * Sales (30 days), Level) in the real table frame. */
export function StockSkeleton() {
  return (
    <>
      <div className="mb-4 flex w-fit gap-1 rounded-xl bg-[#EEF0F3] p-1">
        {["w-12", "w-20", "w-24", "w-28"].map((w) => (
          <span key={w} className={`block h-9 ${w} rounded-lg bg-surface`} />
        ))}
      </div>
      <Bone className="mb-6 h-11 w-full max-w-[380px] rounded-lg" />
      <SkeletonTable headers={["Book", "Price", "In stock", "Sales (30 days)", "Level"]} avatar stackBelow={600} />
    </>
  );
}
