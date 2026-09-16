import type { OnboardingChecklistStatus } from "@/lib/academies/onboarding-checklist";

/**
 * DESIGN.md §11.3's onboarding-checklist widget: "listing preconditions
 * ... with check/cross icons." Pure presentational — the data comes from
 * lib/academies/onboarding-checklist.ts's getOnboardingChecklistStatus(),
 * fetched server-side by the page and passed straight through. Plain
 * check/cross glyphs (✓/✗) rather than an icon library, matching every
 * other shell page in this codebase's plain-inline-styles convention (no
 * icon library is installed anywhere here).
 */
export function OnboardingChecklist({ status }: { status: OnboardingChecklistStatus }) {
  return (
    <section style={{ marginBottom: "2rem" }}>
      <h2>Onboarding checklist</h2>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {status.items.map((item) => (
          <li
            key={item.key}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "0.5rem",
              padding: "0.4rem 0",
              borderBottom: "1px solid #e5e7eb",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                color: item.satisfied ? "#0a7d2c" : "#b91c1c",
                fontWeight: 700,
                width: "1.25rem",
                flexShrink: 0,
              }}
            >
              {item.satisfied ? "✓" : "✗"}
            </span>
            <div>
              <div style={{ fontWeight: 600 }}>
                {item.label}{" "}
                <span
                  style={{
                    fontWeight: 400,
                    color: item.satisfied ? "#0a7d2c" : "#b91c1c",
                  }}
                >
                  ({item.satisfied ? "satisfied" : "not satisfied"})
                </span>
              </div>
              <div style={{ color: "#4b5563", fontSize: "0.9rem" }}>{item.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      {!status.allSatisfied && (
        <p style={{ color: "#b45309", marginTop: "0.75rem" }}>
          Every item above must be satisfied before this academy can be activated.
        </p>
      )}
    </section>
  );
}
