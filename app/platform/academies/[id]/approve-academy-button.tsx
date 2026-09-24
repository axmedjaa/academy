"use client";

import { useState, useTransition } from "react";
import { approveAcademyAction } from "@/lib/academies/approve-actions";
import { Button, ErrorMessage } from "@/app/academy/_shell/ui";

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
    return <p className="text-sm font-medium text-success">Academy approved.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" className="self-start" onClick={handleApprove} disabled={isPending}>
        {isPending ? "Approving..." : "Approve academy"}
      </Button>
      {error && <ErrorMessage message={error} />}
    </div>
  );
}
