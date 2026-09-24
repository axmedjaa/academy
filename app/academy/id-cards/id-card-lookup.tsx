"use client";

import { useActionState, useState } from "react";
import { runIdCardAction, type IdCardFormState } from "@/lib/academies/id-cards-actions";
import { Button, ErrorMessage, Field, Section, inputClass } from "@/app/academy/_shell/ui";
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
 * visual card (app/academy/id-cards/id-card-visual.tsx) renders instead of
 * a plain `<dl>` — see that file's module comment for the card-layout/print
 * details. Restyled onto the shared Tailwind shell (Section/Field/Button)
 * to match every other `/academy/*` page; the card visual itself is left
 * untouched (a deliberately distinct physical-card mockup, not a page).
 */
export function IdCardLookup({ academyName }: Props) {
  const [state, formAction, pending] = useActionState(runIdCardAction, initialState);
  const [studentId, setStudentId] = useState("");

  const card = state.card;
  const shownStudentId = state.studentId ?? studentId;

  return (
    <Section>
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="intent" value="lookup" />
        <Field label="Student # or ID" className="min-w-[300px]">
          <input
            type="text"
            name="studentId"
            value={studentId}
            onChange={(event) => setStudentId(event.target.value)}
            placeholder="e.g. STD-E2E-A-001"
            required
            className={inputClass}
          />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? "Working..." : "Look up"}
        </Button>
      </form>

      {state.error && (
        <div className="mt-3">
          <ErrorMessage message={state.error.message} />
        </div>
      )}

      {shownStudentId && !state.error && (
        <div className="mt-6 border-t border-border pt-5">
          {card ? (
            <>
              <IdCardVisual card={card} studentName={state.studentName ?? shownStudentId} academyName={academyName} />
              <form action={formAction} className="mt-3">
                <input type="hidden" name="intent" value="reprint" />
                <input type="hidden" name="studentId" value={shownStudentId} />
                <input type="hidden" name="cardId" value={card.id} />
                <Button type="submit" disabled={pending}>
                  {pending ? "Working..." : "Reprint this card"}
                </Button>
              </form>
            </>
          ) : (
            <>
              <p className="text-sm text-muted">No card issued yet for this student.</p>
              <form action={formAction} className="mt-3 flex max-w-md flex-col gap-3">
                <input type="hidden" name="intent" value="issue" />
                <input type="hidden" name="studentId" value={shownStudentId} />
                <Field label="Photo URL (optional)">
                  <input type="text" name="photoFileRef" placeholder="https://…" className={inputClass} />
                </Field>
                <Button type="submit" disabled={pending} className="self-start">
                  {pending ? "Working..." : "Issue card"}
                </Button>
              </form>
            </>
          )}
        </div>
      )}
    </Section>
  );
}
