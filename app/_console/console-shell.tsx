"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BrandMark, Icon } from "@/app/academy/_shell/icons";
import { signOut } from "@/lib/auth/actions";
import { markNotificationsReadAction } from "@/lib/notifications/list-notifications-actions";
import {
  searchAcademyConsoleAction,
  searchPlatformConsoleAction,
  type ConsoleSearchResult,
} from "@/lib/console/search-actions";
import type { ConsoleNavItem, ConsoleShellData } from "@/lib/console/shell-data";

/**
 * Shared shell for the Academy and Platform consoles, built from the active
 * `Platform Console.dc.html` shell (HANDOFF.md: the authoritative design
 * source). Each console passes its own, server-filtered navigation and
 * account data; nothing here decides permissions.
 *
 * Sidebar: light 260px card — brand row (56px), grouped navigation with
 * uppercase section labels (multi-item sections collapse), 38px items with a
 * tinted active state and gold inset bar, and the signed-in user at the
 * bottom. At 640–899px it becomes a 72px icon rail with tooltips; below
 * 640px an off-canvas drawer opened from the header. On desktop the user can
 * collapse it to the rail (remembered per browser).
 *
 * Header (56px): menu button (phone), page title with an "Account" crumb on
 * account pages, search with a results dropdown, the academy's branch
 * context, notification bell with a preview dropdown, and the account menu
 * (profile summary, Account settings, Activity, Notifications, Sign out).
 * Layout modes are CSS (`.cs-*` in app/globals.css).
 */

const COLLAPSE_KEY = "console-shell-collapsed";
const COLLAPSE_EVENT = "console-shell-collapsed-change";

function subscribeCollapse(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(COLLAPSE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(COLLAPSE_EVENT, onChange);
  };
}
function readCollapse() {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

function matches(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Longest matching href wins, so /academy/finance/fee-periods lights up
 * "Fee periods", not "Finance". */
function findActive(items: ConsoleNavItem[], pathname: string): ConsoleNavItem | undefined {
  let best: { item: ConsoleNavItem; length: number } | undefined;
  for (const item of items) {
    for (const href of [item.href, ...(item.matchPrefixes ?? [])]) {
      if (matches(pathname, href) && (!best || href.length > best.length)) best = { item, length: href.length };
    }
  }
  return best?.item;
}

const ACCOUNT_TITLES: Record<string, string> = {
  "/account/security": "Account settings",
  "/account/activity": "Activity",
  "/account/verify-email": "Verify email",
};

function relativeTime(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return "Just now";
}

/** Closes a popover on outside pointer-down or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) close();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

const MENU_ITEM =
  "flex min-h-11 w-full items-center gap-3 rounded-lg border-0 bg-transparent px-3 text-left text-sm !text-ink no-underline transition-colors duration-150 hover:bg-app hover:no-underline";

export function ConsoleShell({
  data,
  banner,
  fontClassName,
  children,
}: {
  data: ConsoleShellData;
  banner?: ReactNode;
  fontClassName?: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState(false);
  const collapsed = useSyncExternalStore(subscribeCollapse, readCollapse, () => false);

  // Close transient UI on navigation (adjusting state during render rather
  // than in an effect — React's documented pattern for prop-driven resets).
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setDrawerOpen(false);
    setMenuOpen(false);
    setBellOpen(false);
    setMobileSearch(false);
  }

  const allItems = data.groups.flatMap((group) => group.items);
  const active = findActive(allItems, pathname);
  const accountTitle = Object.entries(ACCOUNT_TITLES).find(([href]) => matches(pathname, href))?.[1];
  const title =
    accountTitle ??
    active?.label ??
    (matches(pathname, "/academy/notifications")
      ? "Notifications"
      : data.console === "platform"
        ? "Platform Console"
        : "Academy Console");
  const crumb = accountTitle ? "Account" : null;

  function toggleCollapsed() {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, collapsed ? "0" : "1");
    } catch {
      // Storage blocked: the toggle simply doesn't persist.
    }
    window.dispatchEvent(new Event(COLLAPSE_EVENT));
  }

  // Drawer: lock page scroll, Escape closes, focus moves in and back out.
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!drawerOpen) return;
    const previous = document.body.style.overflow;
    const opener = menuButtonRef.current;
    document.body.style.overflow = "hidden";
    drawerCloseRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [drawerOpen]);

  const userInitials = initials(data.user.name);

  return (
    <div
      className={`cs-root min-h-screen bg-app ${fontClassName ?? ""}`}
      data-drawer={drawerOpen}
      data-collapsed={collapsed}
    >
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[200] -translate-y-16 rounded-lg bg-ink px-4 py-2 text-sm font-semibold !text-white transition-transform duration-150 focus-visible:translate-y-0"
      >
        Skip to main content
      </a>

      <div className="cs-scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />

      <aside id="console-sidebar" className="cs-sidebar" aria-label="Sidebar">
        <div className="cs-brand -mx-3 flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
          <Link href={data.console === "academy" ? "/academy/dashboard" : "/platform/dashboard"} className="flex min-w-0 flex-1 items-center gap-3 !text-ink no-underline hover:no-underline">
            {data.brand.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- signed storage URL; this codebase renders images with plain <img>
              <img src={data.brand.logoUrl} alt="" className="h-7 w-7 shrink-0 rounded-md object-contain" />
            ) : (
              <span className="flex h-7 max-w-11 shrink-0 items-center">
                <BrandMark size={22} />
              </span>
            )}
            <span className="cs-label min-w-0 leading-tight">
              <span className="block truncate font-semibold">{data.brand.title}</span>
              <span className="block truncate text-xs text-muted">{data.brand.subtitle}</span>
            </span>
          </Link>
          <button
            ref={drawerCloseRef}
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
            className="cs-drawer-only h-11 w-11 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-ink"
          >
            <Icon name="close" />
          </button>
        </div>

        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="cs-edge-toggle absolute -right-3 top-[70px] z-10 h-6 w-6 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-[0_1px_3px_rgba(17,24,39,0.12)] transition-colors duration-150 hover:border-brand hover:text-brand"
        >
          <Icon name="expand_more" width={14} height={14} className={collapsed ? "-rotate-90" : "rotate-90"} />
        </button>

        <nav aria-label="Primary" className="cs-nav min-h-0 flex-1 overflow-y-auto pt-4">
          {data.groups.length === 0 && (
            <p className="cs-label px-3 text-sm text-muted">No tools are available for your account yet.</p>
          )}
          {data.groups.map((group, index) => {
            const hasCurrent = group.items.some((item) => item === active);
            const multi = group.items.length > 1;
            const closed = multi && !!closedGroups[group.title] && !hasCurrent;
            return (
              <div key={group.title} className="mb-2 flex flex-col gap-0.5">
                {index > 0 && <div className="cs-rail-only mx-3 mb-1 h-px bg-border" aria-hidden="true" />}
                {multi ? (
                  <button
                    type="button"
                    onClick={() => setClosedGroups((current) => ({ ...current, [group.title]: !current[group.title] }))}
                    aria-expanded={!closed}
                    className="cs-group-title flex min-h-8 w-full items-center justify-between gap-2 border-0 bg-transparent px-3 py-1 text-left text-[11px] font-bold uppercase tracking-[0.08em] text-muted transition-colors duration-150 hover:text-brand"
                  >
                    <span>{group.title}</span>
                    <Icon
                      name="expand_more"
                      width={16}
                      height={16}
                      className={`transition-transform duration-150 ${closed ? "-rotate-90" : ""}`}
                    />
                  </button>
                ) : (
                  <div className="cs-group-title flex min-h-8 items-center px-3 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-muted">
                    {group.title}
                  </div>
                )}
                {group.items.map((item) => {
                  const isCurrent = item === active;
                  return (
                    <Link
                      key={item.key}
                      href={item.href}
                      aria-current={isCurrent ? "page" : undefined}
                      aria-label={item.label}
                      className={`cs-item relative h-[38px] items-center gap-3 rounded-lg px-3 no-underline transition-colors duration-150 hover:no-underline ${
                        closed ? "hidden" : "flex"
                      } ${
                        isCurrent
                          ? "bg-brand-tint font-semibold !text-brand shadow-[inset_3px_0_0_#F5B638]"
                          : "font-medium !text-ink hover:bg-app"
                      }`}
                    >
                      <Icon name={item.icon} className="shrink-0" />
                      <span className="cs-label truncate whitespace-nowrap">{item.label}</span>
                      <span className="cs-tip" role="tooltip">
                        {item.label}
                      </span>
                    </Link>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="mt-2 border-t border-border">
          <Link
            href="/account/security"
            className="cs-item flex items-center gap-3 rounded-lg px-1 pt-3 !text-ink no-underline hover:no-underline"
            aria-label={`${data.user.name}, account settings`}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-tint font-semibold text-brand">
              {userInitials}
            </span>
            <span className="cs-label min-w-0">
              <span className="block truncate font-semibold">{data.user.name}</span>
              <span className="block truncate text-xs text-muted">{data.user.email}</span>
            </span>
            <span className="cs-tip" role="tooltip">
              {data.user.name}
            </span>
          </Link>
        </div>
      </aside>

      <div className="cs-content flex min-h-screen flex-col">
        <header className="cs-header sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6 min-[1025px]:px-8">
          <button
            ref={menuButtonRef}
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            aria-expanded={drawerOpen}
            aria-controls="console-sidebar"
            className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-ink sm:hidden"
          >
            <Icon name="menu" width={22} height={22} />
          </button>

          <div className={`min-w-0 max-w-[150px] shrink sm:max-w-[260px] min-[1025px]:max-w-[320px] ${data.console === "academy" ? "hidden sm:block" : ""}`}>
            {crumb && <div className="whitespace-nowrap text-xs text-muted">{crumb}</div>}
            <div className="truncate text-base font-semibold text-ink">{title}</div>
          </div>
          {data.console === "academy" && (
            <div className="min-w-0 flex-1 truncate font-semibold text-ink sm:hidden">{data.brand.title}</div>
          )}

          {data.search ? (
            <HeaderSearch console={data.console} search={data.search} />
          ) : (
            <div className="hidden flex-1 sm:block" />
          )}

          {data.contextLabel && (
            <span
              className="hidden h-10 max-w-[180px] shrink-0 items-center gap-2 rounded-lg border border-border-strong bg-surface px-3 text-[13px] text-ink sm:inline-flex"
              title={`Branch: ${data.contextLabel}`}
            >
              <Icon name="apartment" width={16} height={16} className="shrink-0 text-muted" />
              <span className="truncate">{data.contextLabel}</span>
            </span>
          )}

          {data.search && (
            <button
              type="button"
              onClick={() => setMobileSearch(true)}
              aria-label="Search"
              className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-ink sm:hidden"
            >
              <Icon name="search" />
            </button>
          )}
          {!data.search && <div className="flex-1 sm:hidden" />}

          <NotificationBell
            open={bellOpen}
            setOpen={(next) => {
              setBellOpen(next);
              if (next) setMenuOpen(false);
            }}
            notifications={data.notifications}
            onMarked={() => router.refresh()}
          />

          <AccountMenu
            open={menuOpen}
            setOpen={(next) => {
              setMenuOpen(next);
              if (next) setBellOpen(false);
            }}
            user={data.user}
            initials={userInitials}
            notificationsHref={data.notifications.viewAllHref}
          />

          {mobileSearch && data.search && (
            <div className="absolute inset-0 z-[45] flex items-center gap-2 bg-surface px-4 sm:hidden">
              <HeaderSearch console={data.console} search={data.search} mobile onClose={() => setMobileSearch(false)} />
              <button
                type="button"
                onClick={() => setMobileSearch(false)}
                aria-label="Close search"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-ink"
              >
                <Icon name="close" />
              </button>
            </div>
          )}
        </header>

        {banner}

        <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}

function HeaderSearch({
  console: consoleKind,
  search,
  mobile = false,
  onClose,
}: {
  console: ConsoleShellData["console"];
  search: NonNullable<ConsoleShellData["search"]>;
  mobile?: boolean;
  onClose?: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConsoleSearchResult[]>([]);
  const [searchedFor, setSearchedFor] = useState("");
  const [open, setOpen] = useState(mobile);
  const [pending, startTransition] = useTransition();
  const ref = useDismiss(open && !mobile, () => setOpen(false));
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < 2) return;
    const handle = window.setTimeout(() => {
      startTransition(async () => {
        const found =
          consoleKind === "academy" ? await searchAcademyConsoleAction(trimmed) : await searchPlatformConsoleAction(trimmed);
        setResults(found);
        setSearchedFor(trimmed);
      });
    }, 220);
    return () => window.clearTimeout(handle);
  }, [trimmed, consoleKind]);

  const showResults = open && trimmed.length >= 2;
  const fresh = searchedFor === trimmed;

  function go(href: string) {
    setOpen(false);
    setQuery("");
    onClose?.();
    router.push(href);
  }

  return (
    <div ref={ref} className={`relative min-w-0 flex-1 ${mobile ? "" : "mr-auto hidden max-w-[460px] sm:block min-[1025px]:ml-6"}`}>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (results[0] && fresh) go(results[0].href);
          else if (consoleKind === "academy" && trimmed) go(`/academy/students?q=${encodeURIComponent(trimmed)}`);
        }}
      >
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
          <Icon name="search" width={18} height={18} />
        </span>
        <input
          type="search"
          value={query}
          autoFocus={mobile}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              onClose?.();
            }
          }}
          aria-label={search.label}
          placeholder={search.placeholder}
          className={`w-full rounded-[10px] border border-border bg-app pl-[38px] pr-3 text-sm text-ink placeholder:text-muted focus:border-brand focus:bg-surface focus:outline-none ${
            mobile ? "h-11 border-border-strong" : "h-10"
          }`}
        />
      </form>
      {showResults && (
        <div
          role="listbox"
          aria-label="Search results"
          className="cs-menu absolute left-0 right-0 top-[46px] z-40 rounded-xl border border-border bg-surface p-2 shadow-[0_12px_32px_rgba(17,24,39,0.18)]"
        >
          {!fresh || pending ? (
            <div className="px-2 py-3 text-sm text-muted">Searching…</div>
          ) : results.length === 0 ? (
            <div className="px-2 py-3 text-sm text-muted">No matches for “{trimmed}”.</div>
          ) : (
            results.map((result) => (
              <button
                key={result.key}
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => go(result.href)}
                className="flex min-h-11 w-full items-center gap-3 rounded-lg border-0 bg-transparent px-2 py-1.5 text-left transition-colors duration-150 hover:bg-brand-tint"
              >
                <span className="shrink-0 text-brand">
                  <Icon name={result.icon} width={18} height={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{result.label}</span>
                  <span className="block truncate text-xs text-muted">{result.sub}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function NotificationBell({
  open,
  setOpen,
  notifications,
  onMarked,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  notifications: ConsoleShellData["notifications"];
  onMarked: () => void;
}) {
  const ref = useDismiss(open, () => setOpen(false));
  const [pending, startTransition] = useTransition();
  const unreadIds = notifications.latest.filter((item) => item.unread).map((item) => item.id);
  const count = notifications.unreadCount;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Notifications${count > 0 ? `, ${count} unread` : ""}`}
        className={`relative flex h-10 w-10 items-center justify-center rounded-lg border-0 transition-colors duration-150 hover:bg-brand-tint hover:text-brand ${
          open ? "bg-brand-tint text-brand" : "bg-transparent text-ink"
        }`}
      >
        <Icon name="notifications" />
        {count > 0 && (
          <span className="absolute right-0.5 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-bold leading-none text-white">
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="cs-menu absolute -right-[60px] top-12 z-40 w-[300px] overflow-hidden rounded-xl border border-border bg-surface shadow-[0_12px_32px_rgba(17,24,39,0.18)] sm:right-0 sm:w-[340px]"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="font-semibold text-ink">Notifications</div>
            {unreadIds.length > 0 && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await markNotificationsReadAction(unreadIds);
                    if (result.ok) onMarked();
                  })
                }
                className="border-0 bg-transparent py-2 text-[13px] text-brand hover:underline disabled:opacity-60"
              >
                {pending ? "Marking…" : "Mark all as read"}
              </button>
            )}
          </div>
          {notifications.latest.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-muted">You have no notifications.</div>
          ) : (
            notifications.latest.map((item) => (
              <div
                key={item.id}
                role="menuitem"
                className={`flex items-start gap-3 border-b border-border px-4 py-3 ${item.unread ? "bg-brand-tint/40" : ""}`}
              >
                <span
                  className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${item.unread ? "bg-brand" : "bg-border"}`}
                  aria-label={item.unread ? "Unread" : undefined}
                />
                <div className="min-w-0">
                  <div className={`text-[13px] text-ink ${item.unread ? "font-semibold" : ""}`}>{item.label}</div>
                  <div className="text-xs text-muted">{relativeTime(item.createdAt)}</div>
                </div>
              </div>
            ))
          )}
          {notifications.viewAllHref && (
            <Link
              href={notifications.viewAllHref}
              role="menuitem"
              className="flex min-h-11 items-center justify-center text-[13px] font-medium !text-brand hover:bg-app hover:no-underline"
            >
              View all notifications
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function AccountMenu({
  open,
  setOpen,
  user,
  initials: userInitials,
  notificationsHref,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  user: ConsoleShellData["user"];
  initials: string;
  notificationsHref: string | null;
}) {
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex h-11 items-center gap-2 rounded-full border-0 bg-transparent px-1 text-ink transition-colors duration-150 hover:bg-app"
      >
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-tint text-[13px] font-semibold text-brand">
          {userInitials}
        </span>
        <span className="hidden text-left leading-tight min-[1025px]:block">
          <span className="block max-w-[160px] truncate text-[13px] font-medium">{user.name}</span>
          <span className="block text-xs text-muted">{user.roleLabel}</span>
        </span>
        <Icon name="expand_more" width={16} height={16} className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="menu"
          className="cs-menu absolute right-0 top-[52px] z-40 w-[260px] rounded-xl border border-border bg-surface p-2 shadow-[0_12px_32px_rgba(17,24,39,0.18)]"
        >
          <div className="mb-2 border-b border-border px-3 pb-3 pt-2">
            <div className="font-semibold text-ink">{user.name}</div>
            <div className="text-xs text-muted [overflow-wrap:anywhere]">{user.email}</div>
            <span className="mt-2 inline-flex h-6 items-center rounded-full bg-brand-tint px-2.5 text-xs font-semibold text-brand">
              {user.roleLabel}
            </span>
          </div>
          <Link href="/account/security" role="menuitem" className={MENU_ITEM}>
            <Icon name="settings" width={18} height={18} />
            Account settings
          </Link>
          <Link href="/account/activity" role="menuitem" className={MENU_ITEM}>
            <Icon name="history" width={18} height={18} />
            Activity
          </Link>
          {notificationsHref && (
            <Link href={notificationsHref} role="menuitem" className={MENU_ITEM}>
              <Icon name="notifications" width={18} height={18} />
              Notifications
            </Link>
          )}
          <div className="my-2 h-px bg-border" />
          <form action={signOut}>
            <button type="submit" role="menuitem" className={`${MENU_ITEM} !text-[#B91C1C] hover:!bg-[#FEF2F2]`}>
              <Icon name="logout" width={18} height={18} />
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
