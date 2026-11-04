/** Route loading state, following the design's "Loading" preview: the
 * header card, then five KPI bones and a twelve-bar chart bone. */
const CARD =
  "rounded-xl border border-[#E2E5EA] bg-white p-6 shadow-[0_1px_3px_rgba(17,24,39,.07),0_1px_2px_rgba(17,24,39,.04)]";
const HEIGHTS = ["40%", "55%", "48%", "70%", "62%", "80%", "58%", "66%", "74%", "60%", "84%", "92%"];

export default function PlatformReportsLoading() {
  return (
    <div
      aria-busy="true"
      role="status"
      aria-label="Loading reports"
      className="mx-auto w-full max-w-[1400px] px-4 pb-10 pt-4 sm:px-6 sm:pt-6 min-[1025px]:px-8 min-[1025px]:pb-14 min-[1025px]:pt-8"
    >
      <div className="mb-8 overflow-hidden rounded-xl border border-[#E2E5EA] bg-white">
        <div className="h-[3px] bg-[linear-gradient(90deg,#850019_0_72%,#F5B638_72%_100%)]" />
        <div className="flex flex-wrap items-end justify-between gap-5 p-6">
          <div className="grid gap-2">
            <div className="h-3 w-20 rounded-md bg-[#EEF0F3]" />
            <div className="h-8 w-60 rounded-md bg-[#E2E5EA]" />
            <div className="h-4 w-96 max-w-full rounded-md bg-[#EEF0F3]" />
          </div>
          <div className="h-11 w-[420px] max-w-full rounded-xl bg-[#EEF0F3]" />
        </div>
        <div className="h-11 border-t border-[#E2E5EA] bg-[#F7F8FA]" />
      </div>
      <div className="grid gap-6">
        <div className="grid grid-cols-2 gap-4 min-[1025px]:grid-cols-[minmax(0,1.3fr)_repeat(2,minmax(0,1fr))]">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className={`${CARD} grid h-[104px] content-center gap-2.5`}>
              <div className="h-3 w-1/2 rounded-md bg-[#EEF0F3]" />
              <div className="h-7 w-[35%] rounded-md bg-[#E2E5EA]" />
              <div className="h-2.5 w-[65%] rounded-md bg-[#EEF0F3]" />
            </div>
          ))}
        </div>
        <div className={`${CARD} grid h-[280px] grid-cols-12 content-end gap-3`}>
          {HEIGHTS.map((h, i) => (
            <div key={i} className="rounded-t bg-[#EEF0F3]" style={{ height: h }} />
          ))}
        </div>
      </div>
    </div>
  );
}
