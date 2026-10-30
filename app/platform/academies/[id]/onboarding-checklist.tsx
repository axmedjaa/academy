import type { OnboardingChecklistStatus } from "@/lib/academies/onboarding-checklist";
import { Badge } from "@/app/academy/_shell/ui";

/** Design onboarding checklist: a Done / To do pill beside each item, with
 * the item's own explanation when it is not done yet. */
export function OnboardingChecklist({ status }: { status: OnboardingChecklistStatus }) {
  return (
    <section className="min-w-0 rounded-card border border-border bg-surface p-5 shadow-card">
      <h2 className="mb-3 text-[15px] font-semibold text-ink">Onboarding checklist</h2>
      <ul role="list" className="border-t border-border">
        {status.items.map((item) => (
          <li key={item.key} className="flex items-start gap-3 border-b border-border py-2.5 last:border-b-0">
            <span className="w-[72px] shrink-0">
              <Badge label={item.satisfied ? "Done" : "To do"} tone={item.satisfied ? "green" : "amber"} />
            </span>
            <span className="min-w-0 text-sm">
              <span className="block text-ink">{item.label}</span>
              {!item.satisfied && <span className="block text-xs text-[#4B5563]">{item.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      {!status.allSatisfied && (
        <p className="mt-3 text-xs text-[#92400E]">Every item must be done before the academy can be activated.</p>
      )}
    </section>
  );
}
