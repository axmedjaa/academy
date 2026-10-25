"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { runIdCardAction } from "@/lib/academies/id-cards-actions";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Button } from "@/app/academy/_shell/ui";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";
import { StudentPhotoField } from "@/app/academy/students/student-photo-field";

/**
 * Issue and reprint (design A18) go through the existing `runIdCardAction`
 * (keyed by `intent`), which re-checks access, tenant and branch scope on
 * the server and writes the audit entry. The page re-reads the cards after
 * a success.
 */
function useIdCardAction() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function run(fields: Record<string, string>, success: string) {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    startTransition(async () => {
      try {
        const result = await runIdCardAction({ ok: false }, data);
        if (!result.ok) {
          showErrorToast(result.error?.message ?? "Something went wrong. Try again.");
          return;
        }
        showSuccessToast(success);
        router.refresh();
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
    });
  }
  return { pending, run };
}

/** Header actions: Print card (when a card exists) and Issue new card. */
export function IdCardHeaderActions({ studentId, hasCard, canManage }: { studentId: string; hasCard: boolean; canManage: boolean }) {
  const { pending, run } = useIdCardAction();
  return (
    <>
      {hasCard && (
        <Button type="button" variant="secondary" onClick={() => window.print()}>
          Print card
        </Button>
      )}
      {canManage && (
        <Button
          type="button"
          disabled={pending}
          onClick={() => run({ intent: "issue", studentId }, hasCard ? "New card issued." : "Card issued.")}
        >
          {pending ? "Issuing…" : hasCard ? "Issue new card" : "Issue card"}
        </Button>
      )}
    </>
  );
}

/** Row action: counts one more print of this card; its number does not change. */
export function ReprintButton({ studentId, cardId, cardNumber }: { studentId: string; cardId: string; cardNumber: string }) {
  const { pending, run } = useIdCardAction();
  return (
    <button
      type="button"
      disabled={pending}
      aria-label={`Reprint card ${cardNumber}`}
      onClick={() => run({ intent: "reprint", studentId, cardId }, "Reprint recorded. The card number does not change.")}
      className={ROW_BTN}
    >
      {pending ? "Saving…" : "Reprint"}
    </button>
  );
}

/** The student's photo, printed on the card front: the same upload the
 * student page uses (its own server-side permission check and audit). */
export function IdCardPhotoField({ studentId, photoUrl }: { studentId: string; photoUrl: string | null }) {
  const router = useRouter();
  return <StudentPhotoField mode="edit" studentId={studentId} currentPhotoUrl={photoUrl} onChanged={() => router.refresh()} />;
}
