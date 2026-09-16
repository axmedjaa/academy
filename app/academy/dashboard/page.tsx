// PLAN.md Item 28 — "Minimal `/academy/dashboard` shell." Access
// (authentication, membership, subscription/closure status, and the
// Past-Due grace banner) is already resolved by app/academy/layout.tsx
// before this page ever renders, so this page does no gate check of its
// own and has no real content yet.
//
// DESIGN.md §9 describes this route's eventual full content ("Summary
// cards (active students, staff, upcoming exams, pending approvals,
// recent payments), alerts..., compact usage indicator... linking to
// Settings") — that's deliberately out of scope here per this item's own
// "minimal" wording (the assignment brief: "do not build out real
// dashboard widgets/stats, this is just the entry point future items will
// fill in"). Real widgets depend on data models Phase 2 hasn't built yet
// (students: Item 38, staff: Item 35, usage: Item 41), so this is left as
// a plain placeholder for those items to fill in.
export default function AcademyDashboardPage() {
  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif" }}>
      <h1>Academy dashboard</h1>
      <p>Welcome to your academy console. This is a placeholder shell — future items will add real content here.</p>
    </main>
  );
}
