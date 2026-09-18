"use client";

import { useActionState, useState } from "react";
import { runIdCardAction, type IdCardFormState } from "@/lib/academies/id-cards-actions";
import { Card, EmptyState, ErrorMessage, PrimaryButton } from "@/app/academy/_shell/ui";
import { color, spacing } from "@/lib/ui/theme";
import { IdCardVisual } from "./id-card-visual";

const initialState: IdCardFormState = { ok: false };

interface Props {
  academyName: string;
}

/**
 * `/academy/id-cards`'s only UI: paste a student id, see whether they
 * already have a card, and issue or reprint one. Kept deliberately simple
 * (no student search/autocomplete) since Items 38/39 own
 * `/academy/students`'s search UI and this item doesn't depend on it being
 * built — see app/academy/id-cards/page.tsx's module comment.
 *
 * All three forms (lookup/issue/reprint) share a single `useActionState`
 * bound to `runIdCardAction`, keyed by a hidden `intent` field — see that
 * function's own doc comment for why three separate hooks would show stale
 * results.
 *
 * Phase D addition (this wave): once a card is found or issued, the actual
 * visual card (app/academy/id-cards/id-card-view.tsx) renders instead of
 * the old plain `<dl>` fields — see that file's module comment for the
 * card-layout/print details.
 */
export function IdCardLookup({ academyName }: Props) {
  const [state, formAction, pending] = useActionState(runIdCardAction, initialState);
  const [studentId, setStudentId] = useState("");

  const card = state.card;
  const shownStudentId = state.studentId ?? studentId;

  return (
    <Card>
      <form
        action={formAction}
        style={{ display: "flex", gap: spacing.sm, alignItems: "flex-end", flexWrap: "wrap" }}
      >
        <input type="hidden" name="intent" value="lookup" />
        <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
          Student id
          <input
            type="text"
            name="studentId"
            value={studentId}
            onChange={(event) => setStudentId(event.target.value)}
            required
            style={{ minWidth: 300 }}
          />
        </label>
        <PrimaryButton type="submit" disabled={pending}>
          {pending ? "Working..." : "Look up"}
        </PrimaryButton>
      </form>

      {state.error && (
        <div style={{ marginTop: spacing.sm }}>
          <ErrorMessage message={state.error.message} />
        </div>
      )}

      {shownStudentId && !state.error && (
        <div style={{ marginTop: spacing.lg, borderTop: `1px solid ${color.border}`, paddingTop: spacing.md }}>
          {card ? (
            <>
              <IdCardVisual card={card} studentName={state.studentName ?? shownStudentId} academyName={academyName} />
              <form action={formAction} style={{ marginTop: spacing.sm }}>
                <input type="hidden" name="intent" value="reprint" />
                <input type="hidden" name="studentId" value={shownStudentId} />
                <input type="hidden" name="cardId" value={card.id} />
                <PrimaryButton type="submit" disabled={pending}>
                  {pending ? "Working..." : "Reprint this card"}
                </PrimaryButton>
              </form>
            </>
          ) : (
            <>
              <EmptyState message="No card issued yet for this student." />
              <form
                action={formAction}
                style={{ display: "flex", flexDirection: "column", gap: spacing.sm, maxWidth: 420 }}
              >
                <input type="hidden" name="intent" value="issue" />
                <input type="hidden" name="studentId" value={shownStudentId} />
                <label style={{ display: "flex", flexDirection: "column", fontSize: "0.85rem" }}>
                  Photo URL (optional)
                  <input type="text" name="photoFileRef" placeholder="https://…" style={{ width: "100%" }} />
                </label>
                <PrimaryButton type="submit" disabled={pending} style={{ alignSelf: "flex-start" }}>
                  {pending ? "Working..." : "Issue card"}
                </PrimaryButton>
              </form>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
