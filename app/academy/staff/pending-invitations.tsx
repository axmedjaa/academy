"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { StaffInvitationRecord } from "@/lib/academies/staff-invitations";
import { revokeStaffInvitation } from "@/lib/academies/staff-actions";
import { ACADEMY_ROLE_LABELS } from "@/lib/auth/role-labels";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";

/**
 * LEGACY: invitations emailed before staff accounts were created directly
 * (lib/academies/staff-invitations.ts). They can still be accepted until
 * they expire; none can be sent or re-sent any more. Only invitations this
 * person could have sent are listed; Cancel revokes one (re-checked on the
 * server). Disappears once none is pending.
 */
export function PendingInvitations({
  invitations,
  branchNames,
}: {
  invitations: StaffInvitationRecord[];
  branchNames: Record<string, string>;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (invitations.length === 0) return null;

  function run(id: string, action: () => Promise<void>) {
    setBusyId(id);
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } finally {
        setBusyId(null);
      }
    });
  }

  return (
    <section aria-labelledby="pending-invitations-title" className="mb-6 rounded-2xl border border-border bg-surface p-4 shadow-card sm:p-5">
      <h2 id="pending-invitations-title" className="mb-3 text-base font-semibold text-ink">
        Earlier invitations <span className="ml-1 text-sm font-medium text-muted">({invitations.length})</span>
      </h2>
      <p className="mb-2 text-sm text-muted">
        Sent before staff accounts were created directly. Each can still be accepted until it expires. Creating a staff account for the
        same email cancels its invitation.
      </p>
      <ul className="divide-y divide-border">
        {invitations.map((invite) => {
          const where = invite.allBranchAccess
            ? "All branches"
            : invite.branchIds.map((id) => branchNames[id] ?? "Branch").join(", ") || "No branch";
          const busy = busyId === invite.id;
          return (
            <li key={invite.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-ink">{invite.fullName}</div>
                <div className="truncate text-sm text-muted">
                  {invite.email} · {ACADEMY_ROLE_LABELS[invite.role]} · {where}
                </div>
              </div>
              <span className={`text-xs font-semibold ${invite.expired ? "text-[#991B1B]" : "text-muted"}`}>
                {invite.expired ? "Expired" : `Expires ${invite.expiresAt.toISOString().slice(0, 10)}`}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(invite.id, async () => {
                      const result = await revokeStaffInvitation(invite.id);
                      if (!result.ok) showErrorToast(result.error.message);
                      else showSuccessToast("Invitation cancelled.");
                    })
                  }
                  className="inline-flex min-h-10 items-center rounded-lg border border-border-strong bg-surface px-3 text-sm font-semibold text-[#B91C1C] hover:bg-[#FEF2F2] disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
