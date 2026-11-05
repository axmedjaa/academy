
/**
 * Book Management loading states (design B11). The full-page skeleton
 * mirrors the layout: burgundy hero with its four totals, the four-step
 * roadmap and the section tabs. Each section then has its own skeleton in
 * the shape of what it loads (book cards, campaign cards, order cards,
 * KPI rows, history rows), so nothing jumps when the content arrives.
 * Motion is a soft pulse that stops under prefers-reduced-motion.
 */

const pulse = "animate-pulse motion-reduce:animate-none";

/** The design's skeleton block (#E8EAEE): visible on both the grey page
 * and white cards, unlike the page-background grey. */
function Bone({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`${pulse} bg-[#E8EAEE] ${className}`} />;
}
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

function Steps() {
  return (
    <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3.5">
          <Bone className="h-7 w-7 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <Bone className="h-4 w-28 rounded" />
            <Bone className="mt-1.5 h-3 w-40 max-w-full rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Kpis({ count = 4 }: { count?: number }) {
  return (
    <div className="mb-5 grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-4 sm:grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`${card} flex flex-col gap-3 p-4`}>
          <div className="flex items-center gap-2.5">
            <Bone className="h-8 w-8 rounded-[10px]" />
            <Bone className="h-3.5 w-24 rounded" />
          </div>
          <div>
            <Bone className="h-7 w-20 rounded-md" />
            <Bone className="mt-2 h-3 w-28 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Note() {
  return <div className={`mb-4 h-14 rounded-xl border border-[#BFDBFE] bg-[#EFF6FF] ${pulse}`} />;
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
          <div className="flex flex-col gap-3.5 py-4 pl-[26px] pr-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Bone className="h-11 w-11 rounded-full" />
                <div>
                  <Bone className="h-4 w-36 rounded" />
                  <Bone className="mt-1.5 h-3 w-48 rounded" />
                </div>
              </div>
              <Bone className="h-6 w-40 rounded-full" />
            </div>
            <Bone className="h-3.5 w-2/3 rounded" />
            <div className="grid grid-cols-3 gap-2.5">
              {[0, 1, 2].map((j) => (
                <Bone key={j} className="h-[58px] rounded-xl" />
              ))}
            </div>
            <Bone className="h-2 w-full rounded" />
            <div className="flex gap-2">
              <Bone className="h-11 flex-1 rounded-lg" />
              <Bone className="h-11 flex-1 rounded-lg" />
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
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))] gap-4">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-card">
            <div className="flex items-start gap-3.5">
              <Bone className="h-[88px] w-16 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1">
                <Bone className="h-4 w-4/5 rounded" />
                <Bone className="mt-2 h-3 w-1/2 rounded" />
                <Bone className="mt-3 h-5 w-16 rounded" />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Bone className="h-3.5 w-36 rounded" />
              <Bone className="h-5 w-16 rounded-full" />
            </div>
            <Bone className="h-3.5 w-20 rounded" />
            <Bone className="h-11 w-full rounded-lg" />
            <div className="grid grid-cols-3 gap-2">
              <Bone className="h-11 rounded-lg" />
              <Bone className="h-11 rounded-lg" />
              <Bone className="h-11 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Sell Book: the two path cards, search and sale cards. */
export function SellSkeleton() {
  return (
    <>
      <Head />
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {["border-t-brand", "border-t-[#F5B638]"].map((top) => (
          <div key={top} className={`${card} flex flex-col gap-3 border-t-4 ${top} p-5`}>
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
      <Steps />
      <Kpis count={4} />
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
      <Steps />
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
      <Steps />
      <Kpis count={4} />
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

/** Generic section loading (design B11), for any section without its own. */
export function BooksSectionSkeleton() {
  return (
    <>
      <Bone className="h-7 w-[220px] rounded-md" />
      <Bone className="mb-5 mt-2.5 h-4 w-[340px] max-w-full rounded-md" />
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className={`flex items-center gap-4 p-4 ${i ? "border-t border-border" : ""}`}>
            <Bone className="h-12 w-9 shrink-0 rounded" />
            <div className="min-w-0 flex-1">
              <Bone className="h-3.5 w-3/5 rounded-md" />
              <Bone className="mt-2 h-3 w-[35%] rounded-md" />
            </div>
            <Bone className="h-[22px] w-20 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </>
  );
}

export function BooksPageSkeleton() {
  return (
    <div className="text-sm">
      {/* Hero */}
      <div className="relative mb-6 overflow-hidden rounded-[20px] bg-[linear-gradient(135deg,#850019_0%,#5E0012_100%)] p-[22px] shadow-[0_10px_28px_rgba(133,0,25,0.28)] sm:p-8">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0 flex-[1_1_320px]">
            <div className={`h-3 w-32 rounded bg-white/25 ${pulse}`} />
            <div className="mt-3 text-[28px] font-bold leading-[1.1] tracking-[-0.02em] text-white sm:text-4xl">Book Management</div>
            <div className={`mt-3 h-4 w-[360px] max-w-full rounded bg-white/20 ${pulse}`} />
            <div className="mt-5 flex flex-wrap gap-3">
              <div className={`h-12 w-32 rounded-[10px] bg-[#F5B638]/70 ${pulse}`} />
              <div className={`h-12 w-28 rounded-[10px] border border-white/40 bg-white/10 ${pulse}`} />
              <div className={`h-12 w-56 rounded-[10px] border border-white/40 bg-white/10 ${pulse}`} />
            </div>
          </div>
          <div className="flex-none">
            <div className={`h-3 w-24 rounded bg-white/25 ${pulse}`} />
            <div className={`mt-2 h-14 w-20 rounded-lg bg-white/20 sm:h-[72px] ${pulse}`} />
          </div>
        </div>
        <div className="mt-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-[14px] border border-white/20 bg-white/[0.12] px-4 py-3.5">
              <div className={`h-3 w-24 max-w-full rounded bg-white/25 ${pulse}`} />
              <div className={`mt-2 h-6 w-20 rounded bg-white/25 ${pulse}`} />
              <div className={`mt-2 h-3 w-28 max-w-full rounded bg-white/15 ${pulse}`} />
            </div>
          ))}
        </div>
      </div>

      {/* Roadmap */}
      <div className="mb-4 overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
        <div className="relative hidden grid-cols-4 px-2 pb-[18px] pt-5 sm:grid">
          <div aria-hidden="true" className="absolute left-[12.5%] right-[12.5%] top-[38px] h-1 rounded-sm bg-border" />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="relative flex flex-col items-center gap-2">
              <div className="h-10 w-10 rounded-full border-[3px] border-border-strong bg-surface" />
              <Bone className="mt-1 h-4 w-28 max-w-full rounded" />
              <Bone className="h-3 w-36 max-w-full rounded" />
              <Bone className="h-6 w-8 rounded-full" />
            </div>
          ))}
        </div>
        <div className="px-3.5 py-2 sm:hidden">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex min-h-[60px] items-center gap-3.5 py-2.5">
              <div className="h-9 w-9 shrink-0 rounded-full border-[3px] border-border-strong bg-surface" />
              <div className="min-w-0 flex-1">
                <Bone className="h-4 w-32 rounded" />
                <Bone className="mt-1.5 h-3 w-44 max-w-full rounded" />
              </div>
              <Bone className="h-6 w-8 rounded-full" />
            </div>
          ))}
        </div>
      </div>

      {/* Section tabs */}
      <div className="mb-5 flex items-end gap-6 border-b border-border">
        <Bone className="mb-3 h-5 w-24 rounded" />
        <Bone className="mb-3 h-5 w-28 rounded" />
        <Bone className="mb-2 ml-auto h-11 w-32 rounded-lg" />
      </div>

      <BooksCatalogSkeleton />
    </div>
  );
}
