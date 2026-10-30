"use client";

import { startTransition as startFormTransition, useActionState, useEffect, useState, useTransition, type ReactNode } from "react";
import {
  createPlatformAdminAccount,
  grantPlatformPermission,
  revokePlatformPermission,
  type CreatePlatformAdminAccountState,
} from "@/lib/platform-staff/actions";
import { GRANTABLE_CAPABILITIES, PERMISSION_PRESETS, type GrantableCapability } from "@/lib/platform-staff/capabilities";
import type { PlatformStaffAccount } from "@/lib/platform-staff/staff";
import { guardAction, NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { formatDate } from "@/lib/ui/date";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Button, EmptyState, ErrorMessage, Section } from "@/app/academy/_shell/ui";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import { Icon } from "@/app/academy/_shell/icons";
import { ROW_BTN } from "@/app/academy/_shell/page-blocks";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";

const guardedCreate = guardAction(createPlatformAdminAccount);
const initialCreateState: CreatePlatformAdminAccountState = { ok: false };

const GRANTABLE_COPY: Record<GrantableCapability, { label: string; hint: string }> = {
  recordSubscriptionPayment: {
    label: "Record subscription payments",
    hint: "Add payments for any academy. Verify, reject and reverse stay owner only.",
  },
  queryAuditLogs: { label: "Query platform audit logs", hint: "View the platform audit log." },
  getPlatformReports: { label: "View platform reports and usage", hint: "Usage and the Reports page, without revenue." },
};

const OWNER_ONLY_LABELS: Record<string, string> = {
  registerAcademy: "Register academies",
  approveAcademy: "Approve academies",
  activateAcademy: "Activate academies",
  suspendAcademy: "Suspend academies",
  reactivateAcademy: "Reactivate academies",
  cancelAcademy: "Cancel subscriptions",
  closeAcademy: "Close academies",
  deleteAcademy: "Delete academies",
  renewSubscription: "Renew subscriptions",
  verifySubscriptionPayment: "Verify subscription payments",
  rejectSubscriptionPayment: "Reject subscription payments",
  reverseSubscriptionPayment: "Reverse subscription payments",
  "plans.manage": "Manage plans",
  "platform.revenue.view": "View platform revenue",
  "platform.staff.manage": "Manage platform staff",
  "platform.settings.manage": "Manage platform settings",
};

function initials(email: string): string {
  const parts = email.split("@")[0].split(/[._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

const roleLabel = (account: PlatformStaffAccount) => (account.role === "platform_owner" ? "Platform Owner" : "Platform Admin");

/**
 * Platform staff (design P11): the accounts list beside the selected
 * account's details and permissions. Only the three grantable capabilities
 * can be ticked; every owner-only capability is listed disabled with the
 * reason written out. Presets only tick boxes (they grant what is missing,
 * one grant at a time, through the same audited action). Add staff creates
 * a Platform Admin with no grants.
 */
export function PlatformStaffManager({ staff, ungrantableCapabilities }: { staff: PlatformStaffAccount[]; ungrantableCapabilities: string[] }) {
  const [selectedUserId, setSelectedUserId] = useState<string>(
    (staff.find((account) => account.role === "platform_admin") ?? staff[0])?.userId ?? "",
  );
  const selected = staff.find((account) => account.userId === selectedUserId) ?? staff[0] ?? null;

  if (staff.length === 0) {
    return (
      <Section className="mb-8">
        <EmptyState message="No platform staff yet. Add a Platform Admin to get started." icon={<Icon name="badge" />} />
      </Section>
    );
  }

  return (
    <div className="@container mb-8">
      <div className="grid grid-cols-1 items-start gap-6 @[860px]:grid-cols-2">
        <section className="min-w-0 rounded-card border border-border bg-surface p-5 shadow-card">
          <h2 className="mb-3 text-[15px] font-semibold text-ink">Accounts</h2>
          <ul role="list" className="flex flex-col gap-2">
            {staff.map((account) => {
              const active = account.userId === selected?.userId;
              return (
                <li key={account.userId}>
                  <button
                    type="button"
                    onClick={() => setSelectedUserId(account.userId)}
                    aria-pressed={active}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors duration-150 ${
                      active ? "border-brand bg-brand-tint" : "border-border bg-surface hover:bg-app"
                    }`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-tint text-xs font-bold text-brand ring-1 ring-white">
                      {initials(account.email)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">{account.email}</span>
                      <span className="block text-xs text-[#374151]">
                        {roleLabel(account)}
                        {account.status === "disabled" ? " · Disabled" : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-[#374151]">
                      {account.role === "platform_owner"
                        ? "All"
                        : `${account.grantedCapabilities.filter((c) => (GRANTABLE_CAPABILITIES as readonly string[]).includes(c)).length} of ${GRANTABLE_CAPABILITIES.length}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-muted">A new Platform Admin starts with no grants.</p>
        </section>

        {selected && <StaffDetail key={selected.userId} account={selected} ungrantableCapabilities={ungrantableCapabilities} />}
      </div>
    </div>
  );
}

function StaffDetail({ account, ungrantableCapabilities }: { account: PlatformStaffAccount; ungrantableCapabilities: string[] }) {
  const [isPending, startTransition] = useTransition();
  const [grantError, setGrantError] = useState<string | null>(null);
  const isOwner = account.role === "platform_owner";
  const grantedSet = new Set(account.grantedCapabilities);

  async function call(fn: () => Promise<{ ok: true } | { ok: false; error: { message: string } }>): Promise<string | null> {
    try {
      const result = await fn();
      return result.ok ? null : result.error.message;
    } catch {
      return NETWORK_ERROR_MESSAGE;
    }
  }

  function toggleCapability(capability: string, currentlyGranted: boolean) {
    setGrantError(null);
    startTransition(async () => {
      const error = await call(() =>
        currentlyGranted ? revokePlatformPermission(account.userId, capability) : grantPlatformPermission(account.userId, capability),
      );
      if (error) {
        setGrantError(error);
        showErrorToast(error);
      } else {
        showSuccessToast(currentlyGranted ? "Permission revoked." : "Permission granted.");
      }
    });
  }

  function applyPreset(name: string, capabilities: readonly string[]) {
    setGrantError(null);
    startTransition(async () => {
      for (const capability of capabilities) {
        if (grantedSet.has(capability)) continue;
        const error = await call(() => grantPlatformPermission(account.userId, capability));
        if (error) {
          setGrantError(error);
          showErrorToast(error);
          return;
        }
      }
      showSuccessToast(`${name} preset applied.`);
    });
  }

  async function revokeAll() {
    for (const capability of account.grantedCapabilities) {
      const error = await call(() => revokePlatformPermission(account.userId, capability));
      if (error) return { ok: false as const, error: { message: error } };
    }
    return { ok: true as const };
  }

  const kv = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-b border-border py-2.5 text-sm">
      <dt className="text-[#374151]">{label}</dt>
      <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );

  return (
    <section className="min-w-0 rounded-card border border-border bg-surface p-5 shadow-card" aria-busy={isPending}>
      <div className="mb-3 flex items-center gap-3 border-b border-border pb-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-tint text-sm font-bold text-brand">
          {initials(account.email)}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-base font-semibold text-ink">{account.email}</span>
          <span className="block text-xs text-[#374151]">{roleLabel(account)}</span>
        </span>
      </div>
      <dl>
        {kv("Email", <a href={`mailto:${account.email}`}>{account.email}</a>)}
        {kv("Status", account.status === "active" ? "Active" : "Disabled")}
        {kv("Added", formatDate(account.createdAt))}
        {kv("Last seen", account.lastLoginAt ? formatDate(account.lastLoginAt) : "Never signed in")}
      </dl>

      <h3 className="mt-5 text-sm font-semibold text-ink">Permissions</h3>
      {isOwner ? (
        <p className="mt-1 text-sm text-[#374151]">The platform owner holds every capability. Owner access cannot be changed here.</p>
      ) : (
        <>
          <p className="mt-0.5 text-xs text-muted">Presets are a shortcut only: they tick the boxes below and grant nothing else.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {Object.entries(PERMISSION_PRESETS).map(([name, capabilities]) => (
              <button key={name} type="button" className={ROW_BTN} disabled={isPending} onClick={() => applyPreset(name, capabilities)}>
                {name}
              </button>
            ))}
          </div>

          {grantError && (
            <div className="mt-3">
              <ErrorMessage message={grantError} />
            </div>
          )}

          <ul role="list" className="mt-4 border-t border-border">
            {GRANTABLE_CAPABILITIES.map((capability) => {
              const granted = grantedSet.has(capability);
              return (
                <li key={capability} className="border-b border-border py-3">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={granted}
                      disabled={isPending}
                      onChange={() => toggleCapability(capability, granted)}
                      className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-brand"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">{GRANTABLE_COPY[capability].label}</span>
                      <span className="block text-xs text-[#374151]">{GRANTABLE_COPY[capability].hint}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          <h3 className="mt-5 text-sm font-semibold text-ink">Owner only</h3>
          <ul role="list" className="mt-2 border-t border-border">
            {ungrantableCapabilities.map((capability) => (
              <li key={capability} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 border-b border-border py-2">
                <label className="flex items-center gap-3 text-sm text-[#4B5563]">
                  <input type="checkbox" checked={false} disabled readOnly className="h-[18px] w-[18px] shrink-0" />
                  {OWNER_ONLY_LABELS[capability] ?? capability}
                </label>
                <span className="text-xs text-[#4B5563]">Owner only. Cannot be granted.</span>
              </li>
            ))}
          </ul>

          <div className="mt-5">
            {account.grantedCapabilities.length > 0 ? (
              <ConfirmButton
                label="Revoke all grants"
                title={`Revoke every grant from ${account.email}?`}
                description="The account stays active but can no longer record payments, view the audit log or view reports until granted again."
                successMessage="All grants revoked."
                onConfirm={revokeAll}
              />
            ) : (
              <p className="text-xs text-muted">This account has no grants.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

const ADD_RULES: DesignFormRule[] = [
  {
    name: "email",
    label: "Email",
    required: true,
    check: (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : "Enter a valid email address."),
  },
  {
    name: "password",
    label: "Temporary password",
    required: true,
    check: (value) => (value.length >= 8 ? null : "Use at least 8 characters."),
  },
];

/** Header action: the Add staff dialog (creates a Platform Admin with no grants). */
export function AddStaffButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        Add staff
      </Button>
      <DesignDialog
        open={open}
        onOpenChange={setOpen}
        title="Add staff"
        description="Creates a Platform Admin account with no grants. Share the temporary password privately."
      >
        {open && <AddStaffForm onDone={() => setOpen(false)} />}
      </DesignDialog>
    </>
  );
}

function AddStaffForm({ onDone }: { onDone: () => void }) {
  const [state, formAction, pending] = useActionState(guardedCreate, initialCreateState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(ADD_RULES);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Platform Admin account created.");
      onDone();
    } else if (state.error) {
      showServerError(state.error.message, [
        [/email/i, "email"],
        [/password/i, "password"],
      ]);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startFormTransition(() => formAction(data)))}
    >
      <DialogBody>
        <FieldGrid>
          <DField label="Email" name="email" required error={errors.email} full>
            <input
              type="email"
              name="email"
              autoComplete="off"
              onBlur={blur("email")}
              className={controlClass(Boolean(errors.email))}
              {...invalidProps("email", errors.email)}
            />
          </DField>
          <DField label="Temporary password" name="password" required error={errors.password} full hint="At least 8 characters.">
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              onBlur={blur("password")}
              className={controlClass(Boolean(errors.password))}
              {...invalidProps("password", errors.password)}
            />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onDone} submitLabel="Add staff" pendingLabel="Adding…" pending={pending} />
    </form>
  );
}
