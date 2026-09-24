import type { OnboardingChecklistStatus } from "@/lib/academies/onboarding-checklist";
import { Section } from "@/app/academy/_shell/ui";

/**
 * DESIGN.md §11.3's onboarding-checklist widget: "listing preconditions
 * ... with check/cross icons." Pure presentational — the data comes from
 * lib/academies/onboarding-checklist.ts's getOnboardingChecklistStatus(),
 * fetched server-side by the page and passed straight through. Plain
 * check/cross glyphs (✓/✗), same convention as before this restyle — no
 * icon library is installed anywhere in this codebase.
 */
export function OnboardingChecklist({ status }: { status: OnboardingChecklistStatus }) {
  return (
    <Section>
      <h2 className="mb-2 text-base font-semibold text-ink">Onboarding checklist</h2>
      <ul className="divide-y divide-border">
        {status.items.map((item) => (
          <li key={item.key} className="flex items-start gap-2 py-2.5">
            <span
              aria-hidden="true"
              className={`w-5 shrink-0 font-bold ${item.satisfied ? "text-success" : "text-danger"}`}
            >
              {item.satisfied ? "✓" : "✗"}
            </span>
            <div>
              <div className="text-sm font-semibold text-ink">
                {item.label}{" "}
                <span className={`font-normal ${item.satisfied ? "text-success" : "text-danger"}`}>
                  ({item.satisfied ? "satisfied" : "not satisfied"})
                </span>
              </div>
              <div className="text-sm text-muted">{item.detail}</div>
            </div>
          </li>
        ))}
      </ul>
      {!status.allSatisfied && (
        <p className="mt-3 text-sm text-warning">Every item above must be satisfied before this academy can be activated.</p>
      )}
    </Section>
  );
}
