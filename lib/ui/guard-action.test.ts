import { describe, expect, it } from "vitest";
import { NETWORK_ERROR_MESSAGE, guardAction } from "./guard-action";

type State = { ok: boolean; error?: { code: string; message: string } };

describe("guardAction", () => {
  it("passes results through", async () => {
    const action = guardAction<State>(async () => ({ ok: false, error: { code: "conflict", message: "Taken." } }));
    expect(await action({ ok: false }, new FormData())).toEqual({ ok: false, error: { code: "conflict", message: "Taken." } });
  });

  it("turns a failed request into a form error", async () => {
    const action = guardAction<State>(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await action({ ok: false }, new FormData())).toEqual({
      ok: false,
      error: { code: "network", message: NETWORK_ERROR_MESSAGE },
    });
  });

  it("re-throws Next navigation signals", async () => {
    const signal = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/x;307;" });
    const action = guardAction<State>(async () => {
      throw signal;
    });
    await expect(action({ ok: false }, new FormData())).rejects.toBe(signal);
  });
});
