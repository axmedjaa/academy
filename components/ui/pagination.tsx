import * as React from "react"
import { cn } from "@/lib/utils"
import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from "lucide-react"

/**
 * This app's own version of shadcn's pagination primitives — the upstream
 * generator's `pagination.tsx` depends on shadcn's own `Button` component
 * (`buttonVariants`, `class-variance-authority`, Radix `Slot` for `asChild`)
 * purely for link styling. Rather than install a second, parallel Button
 * abstraction and a new dependency (`class-variance-authority`) alongside
 * this app's existing `app/academy/_shell/ui.tsx` Button, these primitives
 * are styled directly with this app's own tokens — same visual language,
 * zero new dependency, no duplicate component. Structure and exported names
 * match the standard shadcn primitives exactly, so any future page can
 * still import `Pagination`/`PaginationContent`/etc. the normal way.
 */

function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      role="navigation"
      aria-label="pagination"
      data-slot="pagination"
      className={cn("mx-auto flex w-full justify-center", className)}
      {...props}
    />
  )
}

function PaginationContent({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn("flex flex-row flex-wrap items-center gap-1", className)}
      {...props}
    />
  )
}

function PaginationItem({ ...props }: React.ComponentProps<"li">) {
  return <li data-slot="pagination-item" {...props} />
}

const LINK_BASE =
  "inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-control px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";

type PaginationLinkProps = {
  isActive?: boolean
} & React.ComponentProps<"a">

/** A disabled link (no `href`) renders as an inert, muted span instead of an
 * anchor — used for Previous/Next at the first/last page, and never
 * clickable, unlike a `disabled` attribute on an `<a>` (which does nothing
 * on its own). */
function PaginationLink({ className, isActive, href, ...props }: PaginationLinkProps) {
  if (!href) {
    return (
      <span
        aria-disabled="true"
        data-slot="pagination-link"
        className={cn(LINK_BASE, "cursor-not-allowed text-muted/50", className)}
        {...(props as React.ComponentProps<"span">)}
      />
    )
  }
  return (
    <a
      href={href}
      aria-current={isActive ? "page" : undefined}
      data-slot="pagination-link"
      data-active={isActive}
      className={cn(
        LINK_BASE,
        isActive ? "bg-brand-tint font-semibold text-brand" : "text-ink hover:bg-app",
        className,
      )}
      {...props}
    />
  )
}

function PaginationPrevious({ className, ...props }: React.ComponentProps<typeof PaginationLink>) {
  return (
    <PaginationLink aria-label="Go to previous page" className={cn("gap-1 pl-2.5", className)} {...props}>
      <ChevronLeftIcon className="size-4" />
      <span className="hidden sm:inline">Previous</span>
    </PaginationLink>
  )
}

function PaginationNext({ className, ...props }: React.ComponentProps<typeof PaginationLink>) {
  return (
    <PaginationLink aria-label="Go to next page" className={cn("gap-1 pr-2.5", className)} {...props}>
      <span className="hidden sm:inline">Next</span>
      <ChevronRightIcon className="size-4" />
    </PaginationLink>
  )
}

function PaginationEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="pagination-ellipsis"
      className={cn("flex size-9 items-center justify-center text-muted", className)}
      {...props}
    >
      <MoreHorizontalIcon className="size-4" />
      <span className="sr-only">More pages</span>
    </span>
  )
}

export {
  Pagination,
  PaginationContent,
  PaginationLink,
  PaginationItem,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
}
