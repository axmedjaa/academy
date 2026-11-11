"use client";

import { useState } from "react";
import { Check, Copy, Eye, EyeOff, RefreshCw } from "lucide-react";
import { controlClass, invalidProps } from "@/app/academy/_shell/design-form";
import { showErrorToast } from "@/lib/ui/toast";

/**
 * Temporary password for a new staff account (direct account creation).
 * The value lives only in this browser until the form posts it; the server
 * validates it again (passwordSchema), hashes it with Argon2id and never
 * sends it back.
 */

// No look-alike characters (0/O, 1/l/I), so it can be read out or typed
// from a note without mistakes.
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%*-_+=?";
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;
export const GENERATED_PASSWORD_LENGTH = 16;

/** Uniform random index below `max` from the Web Crypto CSPRNG (rejection
 * sampling, so no modulo bias). */
function randomIndex(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

/** 16 characters with at least one lower-case letter, upper-case letter,
 * digit and symbol (~100 bits of entropy). */
export function generateTemporaryPassword(length = GENERATED_PASSWORD_LENGTH): string {
  const chars = [LOWER, UPPER, DIGITS, SYMBOLS].map((set) => set[randomIndex(set.length)]);
  while (chars.length < length) chars.push(ALL[randomIndex(ALL.length)]);
  // Fisher–Yates so the guaranteed characters are not always first.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Copies to the clipboard; returns whether it worked. Never logs the value. */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    showErrorToast("Could not copy. Select the password and copy it manually.");
    return false;
  }
}

const iconButton =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-app hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";
const secondaryButton =
  "inline-flex h-10 items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-3 text-sm font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:opacity-60";

export function TemporaryPasswordInput({
  value,
  onChange,
  onBlur,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: string;
}) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <input
          type={visible ? "text" : "password"}
          name="temporaryPassword"
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setCopied(false);
          }}
          onBlur={onBlur}
          // Not saved by the browser as the administrator's own password.
          autoComplete="new-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={128}
          // Named by the DField group heading (DField renders it as `fl-{name}`).
          aria-labelledby="fl-temporaryPassword"
          className={`${controlClass(Boolean(error))} pr-12 font-mono`}
          {...invalidProps("temporaryPassword", error)}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          aria-pressed={visible}
          className={`${iconButton} absolute inset-y-0 right-0 my-auto`}
        >
          {visible ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={secondaryButton}
          onClick={() => {
            onChange(generateTemporaryPassword());
            setVisible(true);
            setCopied(false);
          }}
        >
          <RefreshCw size={16} aria-hidden />
          Generate secure password
        </button>
        <button
          type="button"
          className={secondaryButton}
          disabled={value.length === 0}
          onClick={async () => setCopied(await copyToClipboard(value))}
        >
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** Read-only display of the password on the one-time success screen. */
export function CreatedPasswordDisplay({ value }: { value: string }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-surface pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-[15px] text-ink" aria-label="Temporary password">
        {visible ? value : "•".repeat(Math.min(value.length, 16))}
      </code>
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className={iconButton}
      >
        {visible ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
      </button>
      <button
        type="button"
        onClick={async () => setCopied(await copyToClipboard(value))}
        aria-label={copied ? "Password copied" : "Copy password"}
        className={iconButton}
      >
        {copied ? <Check size={18} aria-hidden className="text-[#15803D]" /> : <Copy size={18} aria-hidden />}
      </button>
    </div>
  );
}
