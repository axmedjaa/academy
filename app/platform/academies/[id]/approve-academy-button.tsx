"use client";

import { useState, useTransition } from "react";
import { approveAcademyAction } from "@/lib/academies/approve-actions";

interface Props {
  academyId: string;
}

/**
 * Shell-scope Approve control for /platform/academies/[id] (PLAN.md Item
 * 21). Deliberately no Reject/Activate/Suspend/Reactivate/Cancel/Close
 * buttons here — those belong to Items 22-26 (onboarding checklist,
 * subscriptions/payments, cancelAcademy-based rejection), none of which
 * exist yet. See the page component for the full list of what's deferred.
 */
export function ApproveAcademyButton({ academyId }: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);

  function handleApprove() {
    setError(null);
    startTransition(async () => {
      const result = await approveAcademyAction(academyId);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSucceeded(true);
    });
  }

  if (succeeded) {
    return <p style={{ color: "green" }}>Academy approved.</p>;
  }

  return (
    <div>
      <button type="button" onClick={handleApprove} disabled={isPending}>
        {isPending ? "Approving..." : "Approve academy"}
      </button>
      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}
    </div>
  );
}
