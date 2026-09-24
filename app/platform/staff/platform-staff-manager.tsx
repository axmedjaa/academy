"use client";

import { useActionState, useState, useTransition } from "react";
import {
  createPlatformAdminAccount,
  grantPlatformPermission,
  revokePlatformPermission,
  type CreatePlatformAdminAccountState,
} from "@/lib/platform-staff/actions";
import {
  CAPABILITY_LABELS,
  GRANTABLE_CAPABILITIES,
  PERMISSION_PRESETS,
} from "@/lib/platform-staff/capabilities";
import type { PlatformStaffAccount } from "@/lib/platform-staff/staff";
import { Badge, Button, ErrorMessage, Field, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";

const initialCreateState: CreatePlatformAdminAccountState = { ok: false };

interface Props {
  staff: PlatformStaffAccount[];
  ungrantableCapabilities: string[];
}

export function PlatformStaffManager({ staff, ungrantableCapabilities }: Props) {
  const [createState, createFormAction, createPending] = useActionState(
    createPlatformAdminAccount,
    initialCreateState,
  );

  const admins = staff.filter((account) => account.role === "platform_admin");
  const [selectedUserId, setSelectedUserId] = useState<string>(
    admins[0]?.userId ?? "",
  );
  const [isPending, startTransition] = useTransition();
  const [grantError, setGrantError] = useState<string | null>(null);

  const selected = staff.find((account) => account.userId === selectedUserId);
  const grantedSet = new Set(selected?.grantedCapabilities ?? []);

  function toggleCapability(capability: string, currentlyGranted: boolean) {
    if (!selectedUserId) return;
    setGrantError(null);
    startTransition(async () => {
      const result = currentlyGranted
        ? await revokePlatformPermission(selectedUserId, capability)
        : await grantPlatformPermission(selectedUserId, capability);
      if (!result.ok) {
        setGrantError(result.error.message);
      }
    });
  }

  function applyPreset(capabilities: readonly string[]) {
    if (!selectedUserId) return;
    setGrantError(null);
    startTransition(async () => {
      for (const capability of capabilities) {
        if (!grantedSet.has(capability)) {
          const result = await grantPlatformPermission(selectedUserId, capability);
          if (!result.ok) {
            setGrantError(result.error.message);
          }
        }
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Section>
        <h2 className="text-base font-semibold text-ink">Create platform admin account</h2>
        <form action={createFormAction} className="mt-4 flex max-w-sm flex-col gap-3">
          <Field label="Email">
            <input type="email" name="email" required className={inputClass} />
          </Field>
          <Field label="Temporary password">
            <input type="password" name="password" required minLength={12} className={inputClass} />
          </Field>
          {createState.error && <ErrorMessage message={createState.error.message} />}
          {createState.ok && <p className="text-sm font-medium text-success">Account created.</p>}
          <Button type="submit" disabled={createPending} className="self-start">
            {createPending ? "Creating..." : "Create account"}
          </Button>
        </form>
      </Section>

      <Section>
        <h2 className="text-base font-semibold text-ink">Staff accounts</h2>
        <div className="mt-4">
          <TableWrap>
            <thead>
              <tr>
                <th className={th}>Email</th>
                <th className={th}>Role</th>
                <th className={th}>Status</th>
                <th className={th}>Granted capabilities</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((account) => (
                <tr key={account.userId} className={trHover}>
                  <td className={`${td} font-medium`}>{account.email}</td>
                  <td className={td}>
                    <Badge label={account.role} tone={account.role === "platform_owner" ? "blue" : "slate"} />
                  </td>
                  <td className={td}>
                    <Badge label={account.status} tone={account.status === "active" ? "green" : "gray"} />
                  </td>
                  <td className={td}>
                    {account.role === "platform_owner"
                      ? "Full access (owner)"
                      : account.grantedCapabilities.length > 0
                        ? account.grantedCapabilities.join(", ")
                        : "None"}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      </Section>

      <Section>
        <h2 className="text-base font-semibold text-ink">Grant permissions</h2>
        {admins.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No platform_admin accounts yet — create one above.</p>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <Field label="Platform admin account" className="max-w-sm">
              <select
                value={selectedUserId}
                onChange={(event) => setSelectedUserId(event.target.value)}
                className={inputClass}
              >
                {admins.map((account) => (
                  <option key={account.userId} value={account.userId}>
                    {account.email}
                  </option>
                ))}
              </select>
            </Field>

            <div className="flex flex-wrap gap-2">
              {Object.entries(PERMISSION_PRESETS).map(([name, capabilities]) => (
                <Button
                  key={name}
                  type="button"
                  variant="secondary"
                  disabled={isPending}
                  onClick={() => applyPreset(capabilities)}
                >
                  Apply {name} preset
                </Button>
              ))}
            </div>

            {grantError && <ErrorMessage message={grantError} />}

            <ul className="flex flex-col gap-2">
              {GRANTABLE_CAPABILITIES.map((capability) => {
                const granted = grantedSet.has(capability);
                return (
                  <li
                    key={capability}
                    className="flex items-center gap-3 rounded-control border border-border px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      checked={granted}
                      disabled={isPending}
                      onChange={() => toggleCapability(capability, granted)}
                      className="h-4 w-4 accent-brand"
                    />
                    <span className="text-sm text-ink">{CAPABILITY_LABELS[capability]}</span>
                  </li>
                );
              })}
              {ungrantableCapabilities.map((capability) => (
                <li
                  key={capability}
                  className="flex items-center gap-3 rounded-control border border-border bg-app px-3 py-2"
                >
                  <input type="checkbox" checked={false} disabled readOnly className="h-4 w-4" />
                  <span className="text-sm text-muted">
                    {capability} — Owner only — this permission cannot be granted
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>
    </div>
  );
}
