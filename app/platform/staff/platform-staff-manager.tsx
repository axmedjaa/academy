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
    <div style={{ display: "flex", flexDirection: "column", gap: "2.5rem" }}>
      <section>
        <h2>Create platform admin account</h2>
        <form
          action={createFormAction}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            maxWidth: 360,
          }}
        >
          <label>
            Email
            <input
              type="email"
              name="email"
              required
              style={{ display: "block", width: "100%" }}
            />
          </label>
          <label>
            Temporary password
            <input
              type="password"
              name="password"
              required
              minLength={12}
              style={{ display: "block", width: "100%" }}
            />
          </label>
          {createState.error && (
            <p role="alert" style={{ color: "crimson" }}>
              {createState.error.message}
            </p>
          )}
          {createState.ok && (
            <p style={{ color: "green" }}>Account created.</p>
          )}
          <button type="submit" disabled={createPending}>
            {createPending ? "Creating..." : "Create account"}
          </button>
        </form>
      </section>

      <section>
        <h2>Staff accounts</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Email</th>
              <th style={{ textAlign: "left" }}>Role</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th style={{ textAlign: "left" }}>Granted capabilities</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((account) => (
              <tr key={account.userId}>
                <td>{account.email}</td>
                <td>{account.role}</td>
                <td>{account.status}</td>
                <td>
                  {account.role === "platform_owner"
                    ? "Full access (owner)"
                    : account.grantedCapabilities.length > 0
                      ? account.grantedCapabilities.join(", ")
                      : "None"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Grant permissions</h2>
        {admins.length === 0 ? (
          <p>No platform_admin accounts yet — create one above.</p>
        ) : (
          <>
            <label>
              Platform admin account
              <select
                value={selectedUserId}
                onChange={(event) => setSelectedUserId(event.target.value)}
                style={{ display: "block", marginBottom: "1rem" }}
              >
                {admins.map((account) => (
                  <option key={account.userId} value={account.userId}>
                    {account.email}
                  </option>
                ))}
              </select>
            </label>

            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "0.5rem",
                marginBottom: "1rem",
              }}
            >
              {Object.entries(PERMISSION_PRESETS).map(([name, capabilities]) => (
                <button
                  key={name}
                  type="button"
                  disabled={isPending}
                  onClick={() => applyPreset(capabilities)}
                >
                  Apply {name} preset
                </button>
              ))}
            </div>

            {grantError && (
              <p role="alert" style={{ color: "crimson" }}>
                {grantError}
              </p>
            )}

            <ul style={{ listStyle: "none", padding: 0 }}>
              {GRANTABLE_CAPABILITIES.map((capability) => {
                const granted = grantedSet.has(capability);
                return (
                  <li key={capability} style={{ marginBottom: "0.5rem" }}>
                    <label>
                      <input
                        type="checkbox"
                        checked={granted}
                        disabled={isPending}
                        onChange={() => toggleCapability(capability, granted)}
                      />{" "}
                      {CAPABILITY_LABELS[capability]}
                    </label>
                  </li>
                );
              })}
              {ungrantableCapabilities.map((capability) => (
                <li key={capability} style={{ marginBottom: "0.5rem" }}>
                  <label style={{ color: "#888" }}>
                    <input type="checkbox" checked={false} disabled readOnly />{" "}
                    {capability} — Owner only — this permission cannot be
                    granted
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
