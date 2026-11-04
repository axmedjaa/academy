"use client";

import {
  startTransition as startFormTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import {
  archivePlatformStaff,
  createPlatformStaffAccount,
  deletePlatformStaffPermanently,
  grantPlatformPermission,
  restorePlatformStaff,
  revokePlatformPermission,
  updatePlatformStaff,
  type PlatformStaffFormState,
} from "@/lib/platform-staff/actions";
import { GRANTABLE_CAPABILITIES, PERMISSION_PRESETS, type GrantableCapability } from "@/lib/platform-staff/capabilities";
import type { PlatformStaffAccount } from "@/lib/platform-staff/staff";
import { guardAction, NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { formatDate } from "@/lib/ui/date";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { Badge, Button, EmptyState, ErrorMessage, Section } from "@/app/academy/_shell/ui";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import { Icon } from "@/app/academy/_shell/icons";
import { ROW_BTN, ROW_BTN_DANGER } from "@/app/academy/_shell/page-blocks";
import {
  ActionDialog,
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

const guardedCreate = guardAction(createPlatformStaffAccount);
const guardedUpdate = guardAction(updatePlatformStaff);
const initialFormState: PlatformStaffFormState = { ok: false };

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
  changeAcademyPlan: "Change academy plans",
  verifySubscriptionPayment: "Verify subscription payments",
  rejectSubscriptionPayment: "Reject subscription payments",
  reverseSubscriptionPayment: "Reverse subscription payments",
  "plans.manage": "Manage plans",
  "platform.revenue.view": "View platform revenue",
  "platform.staff.manage": "Manage platform staff",
  "platform.settings.manage": "Manage platform settings",
  "platform.website.manage": "Manage the public website",
};

const ROLE_LABEL: Record<PlatformStaffAccount["role"], string> = {
  platform_owner: "Platform Owner",
  platform_admin: "Platform Admin",
};

function displayName(account: PlatformStaffAccount): string {
  return account.fullName?.trim() || account.email;
}

function initials(account: PlatformStaffAccount): string {
  const source = account.fullName?.trim() || account.email.split("@")[0];
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

const isArchived = (account: PlatformStaffAccount) => account.archivedAt !== null;

function StatusBadgeFor({ account }: { account: PlatformStaffAccount }) {
  if (isArchived(account)) return <Badge label="Archived" tone="slate" />;
  if (account.status === "disabled") return <Badge label="Sign-in disabled" tone="red" />;
  return <Badge label="Active" tone="green" />;
}

async function call<T extends { ok: boolean }>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    const result = await fn();
    if (result.ok) return { ok: true, value: result };
    const message = (result as unknown as { error?: { message?: string } }).error?.message;
    return { ok: false, message: message ?? "Something went wrong. Please try again." };
  } catch {
    return { ok: false, message: NETWORK_ERROR_MESSAGE };
  }
}

/**
 * Platform staff (design P11): the accounts list beside the selected
 * account's details, lifecycle actions and permissions. Every rule shown
 * here (owner only, no self-archive/demotion, last owner, delete only
 * without history) is enforced again on the server in
 * lib/platform-staff/staff.ts; the UI only explains it up front.
 */
export function PlatformStaffManager({
  staff,
  currentUserId,
  filtered,
  tab,
  ungrantableCapabilities,
}: {
  staff: PlatformStaffAccount[];
  currentUserId: string;
  filtered: boolean;
  tab: "active" | "archived" | "all";
  ungrantableCapabilities: string[];
}) {
  const [selectedUserId, setSelectedUserId] = useState<string>(
    (staff.find((account) => account.role === "platform_admin") ?? staff[0])?.userId ?? "",
  );
  const selected = staff.find((account) => account.userId === selectedUserId) ?? staff[0] ?? null;
  const detailRef = useRef<HTMLDivElement>(null);

  function select(userId: string) {
    setSelectedUserId(userId);
    // Single-column (phone) layout: the details sit under the list, so
    // bring them into view; on wide layouts they're already beside it.
    requestAnimationFrame(() => {
      const node = detailRef.current;
      if (!node || node.getBoundingClientRect().top < window.innerHeight) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      node.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    });
  }

  if (staff.length === 0) {
    const message = filtered
      ? "No staff match these filters. Try another name, email or role."
      : tab === "archived"
        ? "No archived staff. Archived accounts appear here and can be restored."
        : "No platform staff yet. Add a Platform Admin to get started.";
    return (
      <Section className="mb-8">
        <EmptyState message={message} icon={<Icon name={tab === "archived" ? "archive" : "badge"} />} />
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
                    onClick={() => select(account.userId)}
                    aria-pressed={active}
                    className={`flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors duration-150 ${
                      active ? "border-brand bg-brand-tint" : "border-border bg-surface hover:bg-app"
                    }`}
                  >
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold ring-1 ring-white ${
                        isArchived(account) ? "bg-app text-muted" : "bg-brand-tint text-brand"
                      }`}
                    >
                      {initials(account)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">
                        {displayName(account)}
                        {account.userId === currentUserId ? " (you)" : ""}
                      </span>
                      {account.fullName && <span className="block truncate text-xs text-[#374151]">{account.email}</span>}
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#374151]">
                        {ROLE_LABEL[account.role]}
                        <StatusBadgeFor account={account} />
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-xs tabular-nums text-[#374151] min-[420px]:block">
                      Added {formatDate(account.createdAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-muted">A new Platform Admin starts with no grants.</p>
        </section>

        <div ref={detailRef} className="min-w-0 scroll-mt-4">
          {selected && (
            <StaffDetail
              key={selected.userId}
              account={selected}
              isSelf={selected.userId === currentUserId}
              ungrantableCapabilities={ungrantableCapabilities}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StaffDetail({
  account,
  isSelf,
  ungrantableCapabilities,
}: {
  account: PlatformStaffAccount;
  isSelf: boolean;
  ungrantableCapabilities: string[];
}) {
  const [isPending, startTransition] = useTransition();
  const [grantError, setGrantError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const archived = isArchived(account);
  const isOwner = account.role === "platform_owner";
  const grantedSet = new Set(account.grantedCapabilities);

  function toggleCapability(capability: string, currentlyGranted: boolean) {
    setGrantError(null);
    startTransition(async () => {
      const result = await call(() =>
        currentlyGranted ? revokePlatformPermission(account.userId, capability) : grantPlatformPermission(account.userId, capability),
      );
      if (!result.ok) {
        setGrantError(result.message);
        showErrorToast(result.message);
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
        const result = await call(() => grantPlatformPermission(account.userId, capability));
        if (!result.ok) {
          setGrantError(result.message);
          showErrorToast(result.message);
          return;
        }
      }
      showSuccessToast(`${name} preset applied.`);
    });
  }

  async function revokeAll() {
    for (const capability of account.grantedCapabilities) {
      const result = await call(() => revokePlatformPermission(account.userId, capability));
      if (!result.ok) return { ok: false as const, error: { message: result.message } };
    }
    return { ok: true as const };
  }

  async function restore() {
    const result = await call(() => restorePlatformStaff(account.userId));
    return result.ok ? { ok: true } : { ok: false, error: { message: result.message } };
  }

  async function remove(typedEmail: string) {
    const result = await call(() => deletePlatformStaffPermanently(account.userId, typedEmail));
    return result.ok ? { ok: true } : { ok: false, error: { message: result.message } };
  }

  const kv = (label: string, value: ReactNode) => (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3 border-b border-border py-2.5 text-sm">
      <dt className="text-[#374151]">{label}</dt>
      <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );

  const statusText = archived
    ? account.status === "disabled"
      ? "Archived. Signed out everywhere and can't sign in."
      : "Archived. No platform access; still signs in to their academy."
    : account.status === "disabled"
      ? "Sign-in disabled"
      : "Active";

  return (
    <section className="min-w-0 rounded-card border border-border bg-surface p-5 shadow-card" aria-busy={isPending}>
      <div className="mb-3 flex items-center gap-3 border-b border-border pb-4">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
            archived ? "bg-app text-muted" : "bg-brand-tint text-brand"
          }`}
        >
          {initials(account)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base font-semibold text-ink">{displayName(account)}</span>
          <span className="block text-xs text-[#374151]">
            {ROLE_LABEL[account.role]}
            {isSelf ? " · You" : ""}
          </span>
        </span>
        <StatusBadgeFor account={account} />
      </div>
      <dl>
        {kv("Name", account.fullName?.trim() || <span className="text-muted">Not set</span>)}
        {kv("Email", <a href={`mailto:${account.email}`}>{account.email}</a>)}
        {kv("Role", ROLE_LABEL[account.role])}
        {kv("Status", statusText)}
        {kv("Added", formatDate(account.createdAt))}
        {archived && account.archivedAt && kv("Archived", formatDate(account.archivedAt))}
        {kv("Last seen", account.lastLoginAt ? formatDate(account.lastLoginAt) : "Never signed in")}
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        {archived ? (
          <>
            <ConfirmButton
              label="Restore"
              icon="autorenew"
              variant="success"
              className="h-10"
              title={`Restore ${displayName(account)}?`}
              description={`They return as ${ROLE_LABEL[account.role]} with no permission grants and must sign in again${
                isOwner ? ", including the MFA check" : ""
              }. You can grant permissions after restoring.`}
              successMessage="Account restored. They can sign in again."
              onConfirm={restore}
            />
            {account.canPermanentlyDelete && <DeleteButton account={account} onConfirm={remove} />}
          </>
        ) : (
          <>
            <button type="button" className={ROW_BTN} onClick={() => setEditOpen(true)}>
              <Icon name="sliders" width={16} height={16} />
              Edit
            </button>
            <button
              type="button"
              className={ROW_BTN_DANGER}
              disabled={isSelf}
              onClick={() => setArchiveOpen(true)}
              aria-describedby={isSelf ? "self-archive-note" : undefined}
            >
              <Icon name="archive" width={16} height={16} />
              Archive
            </button>
          </>
        )}
      </div>
      {isSelf && !archived && (
        <p id="self-archive-note" className="mt-2 text-xs text-muted">
          You can&apos;t archive yourself or change your own role. Another Platform Owner can.
        </p>
      )}
      {archived && !account.canPermanentlyDelete && (
        <p className="mt-2 text-xs text-muted">
          This account has sign-in or activity history, so it can&apos;t be permanently deleted. It stays archived to keep that
          history intact.
        </p>
      )}

      {!archived && (
        <>
          <EditStaffDialog account={account} isSelf={isSelf} open={editOpen} onOpenChange={setEditOpen} />
          <ArchiveStaffDialog account={account} open={archiveOpen} onOpenChange={setArchiveOpen} />
        </>
      )}

      {!archived && (
        <>
          <h3 className="mt-6 text-sm font-semibold text-ink">Permissions</h3>
          {isOwner ? (
            <p className="mt-1 text-sm text-[#374151]">A Platform Owner holds every capability. Grants apply to Platform Admins only.</p>
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
                    title={`Revoke every grant from ${displayName(account)}?`}
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
        </>
      )}
    </section>
  );
}

/** Permanent delete: typed-email confirmation (checked again on the server). */
function DeleteButton({
  account,
  onConfirm,
}: {
  account: PlatformStaffAccount;
  onConfirm: (typedEmail: string) => Promise<{ ok: boolean; error?: { message: string } }>;
}) {
  return (
    <ConfirmButton
      label="Permanently delete"
      variant="dangerSolid"
      className="h-10"
      title={`Permanently delete ${displayName(account)}?`}
      description="This removes the account and its sign-in details for good. It cannot be undone. The audit log keeps its record of this account and of this deletion."
      confirmLabel="Delete forever"
      confirmInput={{ label: `Type ${account.email} to confirm`, requiredValue: account.email }}
      successMessage="Account permanently deleted."
      onConfirm={() => onConfirm(account.email)}
    />
  );
}

function ArchiveStaffDialog({
  account,
  open,
  onOpenChange,
}: {
  account: PlatformStaffAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Archive ${displayName(account)}?`}
      description="They are signed out of every device at once and lose all platform access. Their records and audit history stay, and you can restore the account later."
      summary={[
        { label: "Account", value: account.email },
        { label: "Role", value: ROLE_LABEL[account.role] },
      ]}
      submitLabel="Archive"
      pendingLabel="Archiving…"
      danger
      rules={[]}
      run={async (data) => {
        const result = await call(() => archivePlatformStaff(account.userId, String(data.get("reason") ?? "")));
        if (!result.ok) return result.message;
        showSuccessToast(
          result.value.ok && !result.value.signInDisabled
            ? "Archived. Platform access removed; they keep sign-in for their academy work."
            : "Archived. They have been signed out and can't sign in.",
        );
        return null;
      }}
      onDone={() => onOpenChange(false)}
    >
      {() => (
        <DField label="Reason" name="reason" full hint="Optional. Saved in the audit log.">
          <textarea name="reason" rows={3} maxLength={500} className={controlClass(false, true)} />
        </DField>
      )}
    </ActionDialog>
  );
}

const NAME_RULE: DesignFormRule = {
  name: "fullName",
  label: "Full name",
  required: true,
  check: (value) => (value.trim().length >= 2 ? null : "Enter the person's full name."),
};
const EMAIL_RULE: DesignFormRule = {
  name: "email",
  label: "Email",
  required: true,
  check: (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : "Enter a valid email address."),
};
const ROLE_RULE: DesignFormRule = { name: "role", label: "Role", required: true, kind: "select" };

const ADD_RULES: DesignFormRule[] = [
  NAME_RULE,
  EMAIL_RULE,
  ROLE_RULE,
  {
    name: "password",
    label: "Temporary password",
    required: true,
    check: (value) => (value.length >= 8 ? null : "Use at least 8 characters."),
  },
];
const EDIT_RULES: DesignFormRule[] = [NAME_RULE, EMAIL_RULE, ROLE_RULE];

const SERVER_FIELD_MATCHERS: [RegExp, string][] = [
  [/email/i, "email"],
  [/password/i, "password"],
  [/name/i, "fullName"],
  [/role|owner/i, "role"],
];

function RoleSelect({
  errors,
  blur,
  defaultValue,
  disabled,
}: {
  errors: Record<string, string>;
  blur: (name: string) => () => void;
  defaultValue?: string;
  disabled?: boolean;
}) {
  return (
    <select
      name={disabled ? undefined : "role"}
      defaultValue={defaultValue ?? ""}
      disabled={disabled}
      onBlur={blur("role")}
      className={controlClass(Boolean(errors.role))}
      {...invalidProps("role", errors.role)}
    >
      <option value="" disabled>
        Choose a role
      </option>
      <option value="platform_admin">Platform Admin: only the permissions you grant</option>
      <option value="platform_owner">Platform Owner: full control, MFA required</option>
    </select>
  );
}

/** Header action: the Add staff dialog. */
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
        description="Creates a platform staff account. A Platform Admin starts with no grants. Share the temporary password privately."
      >
        {open && <AddStaffForm onDone={() => setOpen(false)} />}
      </DesignDialog>
    </>
  );
}

function AddStaffForm({ onDone }: { onDone: () => void }) {
  const [state, formAction, pending] = useActionState(guardedCreate, initialFormState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(ADD_RULES);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Staff account created.");
      onDone();
    } else if (state.error) {
      showServerError(state.error.message, SERVER_FIELD_MATCHERS);
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
          <DField label="Full name" name="fullName" required error={errors.fullName} full>
            <input
              type="text"
              name="fullName"
              autoComplete="off"
              maxLength={120}
              onBlur={blur("fullName")}
              className={controlClass(Boolean(errors.fullName))}
              {...invalidProps("fullName", errors.fullName)}
            />
          </DField>
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
          <DField
            label="Role"
            name="role"
            required
            error={errors.role}
            full
            hint="A new Platform Owner must set up MFA at first sign-in."
          >
            <RoleSelect errors={errors} blur={blur} defaultValue="platform_admin" />
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

function EditStaffDialog({
  account,
  isSelf,
  open,
  onOpenChange,
}: {
  account: PlatformStaffAccount;
  isSelf: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DesignDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${displayName(account)}`}
      description="Changing the role signs this person out on every device; the new role applies at their next sign-in."
    >
      {open && <EditStaffForm account={account} isSelf={isSelf} onDone={() => onOpenChange(false)} />}
    </DesignDialog>
  );
}

function EditStaffForm({ account, isSelf, onDone }: { account: PlatformStaffAccount; isSelf: boolean; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(guardedUpdate, initialFormState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(EDIT_RULES);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Staff account updated.");
      onDone();
    } else if (state.error) {
      showServerError(state.error.message, SERVER_FIELD_MATCHERS);
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
      <input type="hidden" name="userId" value={account.userId} />
      {/* A disabled select submits nothing; the server refuses a self role change regardless. */}
      {isSelf && <input type="hidden" name="role" value={account.role} />}
      <DialogBody>
        <FieldGrid>
          <DField label="Full name" name="fullName" required error={errors.fullName} full>
            <input
              type="text"
              name="fullName"
              defaultValue={account.fullName ?? ""}
              autoComplete="off"
              maxLength={120}
              onBlur={blur("fullName")}
              className={controlClass(Boolean(errors.fullName))}
              {...invalidProps("fullName", errors.fullName)}
            />
          </DField>
          <DField
            label="Email"
            name="email"
            required
            error={errors.email}
            full
            hint={isSelf ? "Change your own email from Account settings, where it is verified." : "Used to sign in. Old reset links stop working."}
          >
            <input
              type="email"
              name="email"
              defaultValue={account.email}
              readOnly={isSelf}
              autoComplete="off"
              onBlur={blur("email")}
              className={controlClass(Boolean(errors.email))}
              {...invalidProps("email", errors.email)}
            />
          </DField>
          <DField
            label="Role"
            name="role"
            required
            error={errors.role}
            full
            hint={isSelf ? "You can't change your own role." : "At least one active Platform Owner must remain."}
          >
            <RoleSelect errors={errors} blur={blur} defaultValue={account.role} disabled={isSelf} />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onDone} submitLabel="Save changes" pendingLabel="Saving…" pending={pending} />
    </form>
  );
}
