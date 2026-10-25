"use client"

import * as React from "react"
import { AlertDialog as AlertDialogPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

/**
 * This product has no dark mode (see app/globals.css's `color-scheme: light`
 * comment) and no shadcn `--popover`/`--accent`/`--destructive` tokens —
 * remapped throughout to this app's own tokens (surface/ink/border/muted),
 * same convention as components/ui/dropdown-menu.tsx and
 * components/ui/sonner.tsx. Overlay/content entrance reuses this app's own
 * registered `animate-fade-in`/`animate-scale-in` keyframes
 * (app/globals.css — the same ones app/academy/_shell/confirm-dialog.tsx's
 * previous hand-rolled dialog already used) instead of the
 * `tailwindcss-animate` plugin's `animate-in`/`fade-in-0`/`zoom-in-95`
 * utilities dropdown-menu.tsx references — that plugin isn't installed in
 * this project, so those particular classes are inert there; not fixed as
 * part of this addition (out of scope), just not repeated here.
 *
 * Structure/behavior otherwise matches the standard shadcn/Radix
 * AlertDialog exactly, so `AlertDialog`/`AlertDialogTrigger`/etc. can be
 * imported and used the normal shadcn way from any future page.
 */

function AlertDialog({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  )
}

function AlertDialogPortal({
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Portal>) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  )
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        // Neutral scrim, same as the design dialogs and the mobile drawer.
        // (It used bg-navy/40, which turned burgundy when the rebrand
        // remapped --color-navy to the brand color.)
        "fixed inset-0 z-[100] bg-[rgba(17,24,39,0.5)] motion-safe:data-[state=open]:animate-fade-in motion-safe:data-[state=closed]:animate-fade-out",
        className
      )}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          // `w-[calc(100%-2rem)]` instead of `w-full` — this is `fixed`
          // with no constraining parent, so `w-full` resolves against the
          // viewport itself (100vw) and would touch both edges with zero
          // gutter on a narrow phone (390px) before `max-w-md` ever gets a
          // chance to matter. The calc() keeps a 16px gutter on each side
          // at any width, every existing caller included (ConfirmButton,
          // RecordPaymentDialog, FormDialog), with no visual change at
          // tablet/desktop widths where max-w-md already governs.
          "fixed top-1/2 left-1/2 z-[100] flex max-h-[85vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-0 overflow-y-auto rounded-card border border-border bg-surface p-5 shadow-card outline-none motion-safe:data-[state=open]:animate-scale-in motion-safe:data-[state=closed]:animate-scale-out",
          className
        )}
        {...props}
      />
    </AlertDialogPortal>
  )
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  )
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn("mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn("text-base font-semibold text-ink", className)}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn("text-sm text-muted", className)}
      {...props}
    />
  )
}

// `transition-[color,background-color,border-color,transform]` instead of
// `transition-colors` — Tailwind's `transition-colors` utility sets
// `transition-property` to color-related properties ONLY, so the
// `active:scale-[0.98]` press feedback below had no transition applied to
// it at all (it snapped instantly instead of easing). Listing `transform`
// alongside the color properties in one arbitrary-value utility is what
// actually makes both animate together.
const ALERT_DIALOG_BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-control px-4 py-2 text-sm font-semibold transition-[color,background-color,border-color,transform] duration-150 ease-out motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100";

/** Sensible standalone default (primary-button look) for a caller that
 * doesn't pass `asChild` — most callers in this app (see
 * app/academy/_shell/confirm-dialog.tsx) use `asChild` with this app's own
 * `Button` component instead, for exact per-action variant coloring
 * (danger/dangerSolid/etc.); this default only matters without that. */
function AlertDialogAction({
  className,
  asChild,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  // With asChild the child button brings its own variant styles. Merging the
  // default brand look into it (Slot concatenates class lists) produced mixed
  // results such as white text on the pale danger background, so the default
  // applies only when this renders its own button.
  return (
    <AlertDialogPrimitive.Action
      data-slot="alert-dialog-action"
      asChild={asChild}
      className={asChild ? className : cn(ALERT_DIALOG_BUTTON_BASE, "bg-brand text-white hover:bg-brand-hover", className)}
      {...props}
    />
  )
}

function AlertDialogCancel({
  className,
  asChild,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  // Same rule as AlertDialogAction: an asChild button keeps its own styles.
  return (
    <AlertDialogPrimitive.Cancel
      data-slot="alert-dialog-cancel"
      asChild={asChild}
      className={asChild ? className : cn(ALERT_DIALOG_BUTTON_BASE, "border border-border bg-surface text-ink hover:bg-app", className)}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
}
