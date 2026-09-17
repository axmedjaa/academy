"use client";

import { useActionState, useState } from "react";
import { runIdCardAction, type IdCardFormState } from "@/lib/academies/id-cards-actions";

const initialState: IdCardFormState = { ok: false };

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
 */
export function IdCardLookup() {
  const [state, formAction, pending] = useActionState(runIdCardAction, initialState);
  const [studentId, setStudentId] = useState("");

  const card = state.card;
  const shownStudentId = state.studentId ?? studentId;

  return (
    <section style={{ marginTop: "1.5rem" }}>
      <form
        action={formAction}
        style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" }}
      >
        <input type="hidden" name="intent" value="lookup" />
        <label style={{ display: "flex", flexDirection: "column" }}>
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
        <button type="submit" disabled={pending}>
          {pending ? "Working..." : "Look up"}
        </button>
      </form>

      {state.error && (
        <p role="alert" style={{ color: "crimson" }}>
          {state.error.message}
        </p>
      )}

      {shownStudentId && (
        <div style={{ marginTop: "1.5rem", borderTop: "1px solid #ddd", paddingTop: "1rem" }}>
          {card ? (
            <>
              <h2>Current card</h2>
              <dl>
                <dt>Card number</dt>
                <dd>{card.cardNumber}</dd>
                <dt>Status</dt>
                <dd>{card.status}</dd>
                <dt>Issued at</dt>
                <dd>{new Date(card.issuedAt).toLocaleString()}</dd>
                <dt>Reprint count</dt>
                <dd>{card.reprintCount}</dd>
              </dl>
              <form action={formAction}>
                <input type="hidden" name="intent" value="reprint" />
                <input type="hidden" name="studentId" value={shownStudentId} />
                <input type="hidden" name="cardId" value={card.id} />
                <button type="submit" disabled={pending}>
                  {pending ? "Working..." : "Reprint this card"}
                </button>
              </form>
            </>
          ) : (
            <>
              <h2>No card issued yet</h2>
              <form
                action={formAction}
                style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}
              >
                <input type="hidden" name="intent" value="issue" />
                <input type="hidden" name="studentId" value={shownStudentId} />
                <label>
                  Photo file reference (optional)
                  <input
                    type="text"
                    name="photoFileRef"
                    style={{ display: "block", width: "100%" }}
                  />
                </label>
                <button type="submit" disabled={pending}>
                  {pending ? "Working..." : "Issue card"}
                </button>
              </form>
            </>
          )}
        </div>
      )}
    </section>
  );
}
