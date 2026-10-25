/**
 * Wraps a `useActionState` server action so a failed request (connection
 * dropped, server unreachable) comes back as an ordinary form error instead
 * of throwing into the page's error boundary — the form keeps what the user
 * typed and they can simply try again. Errors the server itself returns are
 * passed through unchanged; Next's own redirect/not-found signals are
 * re-thrown so navigation still works.
 */

export const NETWORK_ERROR_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

interface ActionState {
  ok: boolean;
  error?: { code: string; message: string };
}

function isNextSignal(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND") || digest.startsWith("NEXT_HTTP_ERROR"));
}

export function guardAction<S extends ActionState>(action: (state: S, data: FormData) => Promise<S>) {
  return async (state: S, data: FormData): Promise<S> => {
    try {
      return await action(state, data);
    } catch (err) {
      if (isNextSignal(err)) throw err;
      return { ...state, ok: false, error: { code: "network", message: NETWORK_ERROR_MESSAGE } } as S;
    }
  };
}
