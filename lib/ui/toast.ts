import { toast } from "sonner";

/**
 * Thin wrapper over sonner's `toast` so every call site in the app uses the
 * same handful of variants with consistent wording conventions, rather than
 * each form re-deciding its own toast shape. Toasts are for operation-level
 * results (create/update/delete/upload succeeded or failed) — validation
 * problems stay inline (see lib/validation/use-field-errors.ts), and
 * unexpected render/application crashes stay the job of
 * app/academy/error.tsx / app/global-error.tsx, not this.
 *
 * `message` must always be a short, non-technical, user-safe string — never
 * a raw error/exception, stack trace, or anything from a database driver.
 * Server actions across this codebase already return friendly
 * `error.message` strings for exactly this reason; pass those through
 * as-is, never `String(err)` or similar.
 */
export const showSuccessToast = (message: string) => toast.success(message);
export const showErrorToast = (message: string) => toast.error(message);
export const showInfoToast = (message: string) => toast.info(message);
