"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { updateContactMessageStatus } from "@/lib/marketing/website-actions";
import type { ContactSubmissionStatus } from "@/lib/marketing/contact-submissions";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Badge, EmptyState, Section } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";

export interface ContactMessageItem {
  id: string;
  fullName: string;
  email: string;
  phone: string | null;
  subject: string;
  message: string;
  status: ContactSubmissionStatus;
  notifiedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

const FILTERS: { key: "all" | ContactSubmissionStatus; label: string }[] = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "read", label: "Read" },
  { key: "archived", label: "Archived" },
];

const TONE = { new: "blue", read: "gray", archived: "slate" } as const;

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

const ACTION =
  "inline-flex h-10 items-center rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:opacity-50";

/** Contact messages from the public website, newest first. */
export function ContactMessagesList({
  rows,
  status,
  newCount,
  totalCount,
}: {
  rows: ContactMessageItem[];
  status: "all" | ContactSubmissionStatus;
  newCount: number;
  totalCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);

  function setStatus(id: string, next: ContactSubmissionStatus, done: string) {
    startTransition(async () => {
      try {
        const result = await updateContactMessageStatus(id, next);
        if (!result.ok) {
          showErrorToast(result.error.message);
          return;
        }
        showSuccessToast(done);
        router.refresh();
      } catch {
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  return (
    <div>
      <nav aria-label="Filter messages" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((filter) => {
          const on = filter.key === status;
          return (
            <Link
              key={filter.key}
              href={filter.key === "all" ? "/platform/website/messages" : `/platform/website/messages?status=${filter.key}`}
              aria-current={on ? "page" : undefined}
              className={`inline-flex h-10 items-center gap-2 rounded-full border px-4 text-sm font-semibold no-underline ${
                on ? "border-brand bg-brand-tint !text-brand" : "border-border bg-surface !text-ink hover:bg-app"
              }`}
            >
              {filter.label}
              {filter.key === "new" && newCount > 0 && (
                <span className="rounded-full bg-brand px-2 text-xs text-white">{newCount}</span>
              )}
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <Section>
          <EmptyState
            message={
              status === "all"
                ? "No messages yet. They appear here when the contact form is on and a visitor sends one."
                : `No ${status} messages.`
            }
            icon={<Icon name="mail" />}
          />
        </Section>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0" aria-label={`${totalCount} messages`}>
          {rows.map((row) => {
            const open = openId === row.id;
            return (
              <li key={row.id} className="rounded-card border border-border bg-surface shadow-card">
                <button
                  type="button"
                  onClick={() => {
                    setOpenId(open ? null : row.id);
                    if (!open && row.status === "new") setStatus(row.id, "read", "Marked as read.");
                  }}
                  aria-expanded={open}
                  aria-controls={`msg-${row.id}`}
                  className="flex w-full cursor-pointer flex-wrap items-start justify-between gap-3 border-0 bg-transparent p-4 text-left"
                >
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[15px] text-ink ${row.status === "new" ? "font-semibold" : "font-medium"}`}>
                      {row.subject}
                    </span>
                    <span className="mt-0.5 block text-sm text-muted [overflow-wrap:anywhere]">
                      {row.fullName} · {row.email}
                      {row.phone ? ` · ${row.phone}` : ""}
                    </span>
                  </span>
                  <span className="flex flex-none items-center gap-3">
                    <Badge label={row.status} tone={TONE[row.status]} />
                    <span className="text-xs text-muted tabular-nums">{formatWhen(row.createdAt)}</span>
                  </span>
                </button>
                {open && (
                  <div id={`msg-${row.id}`} className="border-t border-border px-4 pt-3 pb-4">
                    <p className="text-[15px] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{row.message}</p>
                    <p className="mt-3 text-xs text-muted">
                      {row.notifiedAt
                        ? `Email notification sent ${formatWhen(row.notifiedAt)}.`
                        : "No email notification was sent for this message."}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {row.phone && (
                        <a href={`tel:${row.phone.replace(/[^\d+]/g, "")}`} className={`${ACTION} !text-ink no-underline`}>
                          Call {row.phone}
                        </a>
                      )}
                      <a
                        href={`mailto:${row.email}?subject=${encodeURIComponent(`Re: ${row.subject}`)}`}
                        className={`${ACTION} !text-ink no-underline`}
                      >
                        Reply by email
                      </a>
                      {row.status !== "new" && (
                        <button type="button" disabled={pending} onClick={() => setStatus(row.id, "new", "Marked as new.")} className={ACTION}>
                          Mark as new
                        </button>
                      )}
                      {row.status !== "archived" ? (
                        <button type="button" disabled={pending} onClick={() => setStatus(row.id, "archived", "Message archived.")} className={ACTION}>
                          Archive
                        </button>
                      ) : (
                        <button type="button" disabled={pending} onClick={() => setStatus(row.id, "read", "Message restored.")} className={ACTION}>
                          Restore
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
