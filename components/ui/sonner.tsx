"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * This product uses one fixed light theme everywhere (see app/globals.css's
 * `color-scheme: light` comment) — no next-themes/dark-mode wiring, unlike
 * shadcn's default generated version of this file. Colors map to the same
 * `--color-*` tokens as the rest of the app (app/globals.css's `@theme`
 * block) instead of shadcn's own `--popover`/`--border`/`--radius`
 * variables, which this project never defines.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--color-surface)",
          "--normal-text": "var(--color-ink)",
          "--normal-border": "var(--color-border)",
          "--border-radius": "var(--radius-control)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
