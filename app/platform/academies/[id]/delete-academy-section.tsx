"use client";

import { useRouter } from "next/navigation";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import { deleteAcademy } from "@/lib/academies/delete-academy-actions";
import type { AcademyDeletionEligibility } from "@/lib/academies/delete-academy";

/**
 * Platform Owner-only permanent deletion — deliberately visually and
 * behaviorally distinct from the "Lifecycle actions" section above it
 * (Activate/Suspend/Reactivate/Cancel/Close): those are reversible-ish,
 * routine operations; this is the one irreversible, type-the-name-to-
 * confirm action on this page, so it sits in its own "Danger zone" card
 * with a border/heading that reads as separate, not a sixth lifecycle
 * button among equals.
 *
 * `eligibility` is a server-computed preview only — the actual
 * `deleteAcademy` server action re-checks eligibility itself, inside the
 * deletion transaction, as the real authority (see that function's own
 * comment). This component just decides whether to show the enabled
 * control or the blocked explanation.
 */
export function DeleteAcademySection({ eligibility }: { eligibility: AcademyDeletionEligibility }) {
  const router = useRouter();

  if (!eligibility.eligible) {
    const reasons: string[] = [];
    if (eligibility.blockers.hasFinancialHistory) reasons.push("financial records (charges, payments, income, or expenses)");
    if (eligibility.blockers.hasSubscriptionPayments) reasons.push("recorded subscription payments");
    if (eligibility.blockers.hasCertificates) reasons.push("issued certificates");
    if (eligibility.blockers.hasExamResults) reasons.push("exam results");

    return (
      <div className="rounded-card border border-border bg-app px-4 py-3 text-sm text-muted">
        This academy cannot be permanently deleted because it has {reasons.join(", ")}. Close it instead if it
        should stop operating — closed academies keep their full history and stay verifiable.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        This academy has no financial, subscription-payment, certificate, or exam-result history, so it&apos;s
        eligible for permanent deletion.
      </p>
      <ConfirmButton
        label="Delete Academy"
        variant="danger"
        className="self-start"
        title={`Permanently delete "${eligibility.academyName}"?`}
        description={
          <>
            This action cannot be undone. All of this academy&apos;s disposable data — branches, staff, students,
            courses, batches, timetable, memberships — will be permanently removed. Its audit trail is preserved.
          </>
        }
        confirmInput={{ label: `Type "${eligibility.academyName}" to confirm`, requiredValue: eligibility.academyName }}
        onConfirm={() => deleteAcademy(eligibility.academyId, eligibility.academyName)}
        onSuccess={() => router.push("/platform/academies")}
      />
    </div>
  );
}
