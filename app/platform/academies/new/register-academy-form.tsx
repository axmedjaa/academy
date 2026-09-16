"use client";

import { useActionState, useState, type CSSProperties } from "react";
import {
  registerAcademy,
  REGISTER_ACADEMY_INITIAL_STATE,
} from "@/lib/academies/register-actions";
import type { SubscriptionPlanRecord } from "@/lib/subscriptions/plans";

// DESIGN.md §8 /platform/academies/new: "Pattern C (multi-step). Steps:
// Academy profile ... -> Owner account -> Default branch -> Plan +
// allowances -> Subscription dates -> Review." Item 20 originally deferred
// the last two steps because createAcademySubscription didn't exist yet;
// Item 24 wires it into registerAcademy itself (academy_subscriptions.plan_id
// is NOT NULL with no default, so a plan must be chosen up front), so this
// form now implements the full six-step sequence DESIGN.md describes.
const STEPS = [
  "Academy profile",
  "Owner account",
  "Default branch",
  "Plan & allowances",
  "Subscription dates",
  "Review",
] as const;

const DEFAULT_TRIAL_DAYS = "14";

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${bytes} bytes`;
}

function formatPrice(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

interface FormState {
  name: string;
  defaultCurrency: string;
  type: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  logoRef: string;
  registrationNumber: string;
  primaryContactName: string;
  primaryContactPhone: string;
  ownerEmail: string;
  ownerPassword: string;
  branchName: string;
  branchCode: string;
  branchAddress: string;
  branchPhone: string;
  planId: string;
  startTrial: boolean;
  trialDays: string;
}

const initialFormState: FormState = {
  name: "",
  defaultCurrency: "USD",
  type: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  logoRef: "",
  registrationNumber: "",
  primaryContactName: "",
  primaryContactPhone: "",
  ownerEmail: "",
  ownerPassword: "",
  branchName: "Main Branch",
  branchCode: "MAIN",
  branchAddress: "",
  branchPhone: "",
  planId: "",
  // Judgment call (PLAN.md doesn't specify a default): a fresh academy
  // starts in Trial unless the platform owner explicitly opts out, since
  // the Draft->Trial row is the state machine's primary "plan assigned"
  // path and the more sales-friendly default for onboarding. 14 days
  // mirrors common SaaS trial lengths; PLAN.md gives no specific number.
  startTrial: true,
  trialDays: DEFAULT_TRIAL_DAYS,
};

const fieldLabelStyle: CSSProperties = { display: "block", marginBottom: "0.75rem" };
const inputStyle: CSSProperties = { display: "block", width: "100%", marginTop: "0.25rem" };

interface RegisterAcademyFormProps {
  /** Only is_active plans — "only active plans should be selectable at
   * registration time" — filtered by the page (app/platform/academies/new/
   * page.tsx) before this component ever sees the list. */
  activePlans: SubscriptionPlanRecord[];
}

export function RegisterAcademyForm({ activePlans }: RegisterAcademyFormProps) {
  const [state, formAction, pending] = useActionState(
    registerAcademy,
    REGISTER_ACADEMY_INITIAL_STATE,
  );
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(initialFormState);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function canAdvanceFromProfile(): boolean {
    return form.name.trim().length > 0 && form.defaultCurrency.trim().length === 3;
  }

  function canAdvanceFromOwner(): boolean {
    return form.ownerEmail.trim().length > 0 && form.ownerPassword.length >= 12;
  }

  function canAdvanceFromBranch(): boolean {
    return form.branchName.trim().length > 0 && form.branchCode.trim().length > 0;
  }

  function canAdvanceFromPlan(): boolean {
    return form.planId.trim().length > 0;
  }

  function canAdvanceFromSubscriptionDates(): boolean {
    if (!form.startTrial) return true;
    const days = Number(form.trialDays);
    return Number.isInteger(days) && days >= 1 && days <= 365;
  }

  const selectedPlan = activePlans.find((plan) => plan.id === form.planId);

  return (
    <div>
      <ol style={{ display: "flex", gap: "1rem", padding: 0, listStyle: "none", marginBottom: "1.5rem" }}>
        {STEPS.map((label, index) => (
          <li
            key={label}
            style={{
              fontWeight: index === step ? "bold" : "normal",
              color: index === step ? "#111" : "#888",
            }}
          >
            {index + 1}. {label}
          </li>
        ))}
      </ol>

      {state.error && (
        <p role="alert" style={{ color: "crimson" }}>
          {state.error.message}
        </p>
      )}

      {step === 0 && (
        <section>
          <h2>Academy profile</h2>
          <label style={fieldLabelStyle}>
            Academy name
            <input
              style={inputStyle}
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              required
            />
          </label>
          <label style={fieldLabelStyle}>
            Default currency (3-letter code)
            <input
              style={inputStyle}
              value={form.defaultCurrency}
              maxLength={3}
              onChange={(e) => update("defaultCurrency", e.target.value.toUpperCase())}
              required
            />
          </label>
          <label style={fieldLabelStyle}>
            Type
            <input style={inputStyle} value={form.type} onChange={(e) => update("type", e.target.value)} />
          </label>
          <label style={fieldLabelStyle}>
            Address
            <input style={inputStyle} value={form.address} onChange={(e) => update("address", e.target.value)} />
          </label>
          <label style={fieldLabelStyle}>
            Phone
            <input style={inputStyle} value={form.phone} onChange={(e) => update("phone", e.target.value)} />
          </label>
          <label style={fieldLabelStyle}>
            Email
            <input
              type="email"
              style={inputStyle}
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
            />
          </label>
          <label style={fieldLabelStyle}>
            Website
            <input style={inputStyle} value={form.website} onChange={(e) => update("website", e.target.value)} />
          </label>
          <label style={fieldLabelStyle}>
            Logo
            <input
              style={inputStyle}
              value={form.logoRef}
              onChange={(e) => update("logoRef", e.target.value)}
              placeholder="Uploaded file reference"
            />
          </label>
          <label style={fieldLabelStyle}>
            Registration number
            <input
              style={inputStyle}
              value={form.registrationNumber}
              onChange={(e) => update("registrationNumber", e.target.value)}
            />
          </label>
          <label style={fieldLabelStyle}>
            Primary contact name
            <input
              style={inputStyle}
              value={form.primaryContactName}
              onChange={(e) => update("primaryContactName", e.target.value)}
            />
          </label>
          <label style={fieldLabelStyle}>
            Primary contact phone
            <input
              style={inputStyle}
              value={form.primaryContactPhone}
              onChange={(e) => update("primaryContactPhone", e.target.value)}
            />
          </label>
          <button type="button" onClick={() => setStep(1)} disabled={!canAdvanceFromProfile()}>
            Next: Owner account
          </button>
        </section>
      )}

      {step === 1 && (
        <section>
          <h2>Owner account</h2>
          <p style={{ color: "#555" }}>
            Creates the academy&apos;s first user — role <code>academy_owner</code>.
          </p>
          <label style={fieldLabelStyle}>
            Owner email
            <input
              type="email"
              style={inputStyle}
              value={form.ownerEmail}
              onChange={(e) => update("ownerEmail", e.target.value)}
              required
            />
          </label>
          <label style={fieldLabelStyle}>
            Temporary password
            <input
              type="password"
              style={inputStyle}
              value={form.ownerPassword}
              minLength={12}
              onChange={(e) => update("ownerPassword", e.target.value)}
              required
            />
          </label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" onClick={() => setStep(0)}>
              Back
            </button>
            <button type="button" onClick={() => setStep(2)} disabled={!canAdvanceFromOwner()}>
              Next: Default branch
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section>
          <h2>Default branch</h2>
          <label style={fieldLabelStyle}>
            Branch name
            <input
              style={inputStyle}
              value={form.branchName}
              onChange={(e) => update("branchName", e.target.value)}
              required
            />
          </label>
          <label style={fieldLabelStyle}>
            Branch code
            <input
              style={inputStyle}
              value={form.branchCode}
              onChange={(e) => update("branchCode", e.target.value.toUpperCase())}
              required
            />
          </label>
          <label style={fieldLabelStyle}>
            Branch address
            <input
              style={inputStyle}
              value={form.branchAddress}
              onChange={(e) => update("branchAddress", e.target.value)}
            />
          </label>
          <label style={fieldLabelStyle}>
            Branch phone
            <input
              style={inputStyle}
              value={form.branchPhone}
              onChange={(e) => update("branchPhone", e.target.value)}
            />
          </label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" onClick={() => setStep(1)}>
              Back
            </button>
            <button type="button" onClick={() => setStep(3)} disabled={!canAdvanceFromBranch()}>
              Next: Plan &amp; allowances
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
        <section>
          <h2>Plan &amp; allowances</h2>
          <p style={{ color: "#555" }}>
            academy_subscriptions.plan_id has no default — a plan must be
            chosen now. Only active plans are offered.
          </p>
          {activePlans.length === 0 && (
            <p role="alert" style={{ color: "crimson" }}>
              No active subscription plans exist yet. Create one at
              /platform/plans before registering an academy.
            </p>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {activePlans.map((plan) => (
              <label
                key={plan.id}
                style={{
                  display: "block",
                  border: form.planId === plan.id ? "2px solid #111" : "1px solid #ccc",
                  borderRadius: 4,
                  padding: "0.75rem",
                }}
              >
                <input
                  type="radio"
                  name="planChoice"
                  value={plan.id}
                  checked={form.planId === plan.id}
                  onChange={() => update("planId", plan.id)}
                />{" "}
                <strong>{plan.name}</strong> — {formatPrice(plan.priceAmountCents, plan.currency)} /{" "}
                {plan.billingPeriod}
                <ul style={{ margin: "0.5rem 0 0", color: "#555" }}>
                  <li>Branches: {plan.maxBranches}</li>
                  <li>Students: {plan.maxStudents}</li>
                  <li>Staff: {plan.maxStaff}</li>
                  <li>Courses: {plan.maxCourses}</li>
                  <li>Storage: {formatBytes(plan.maxStorageBytes)}</li>
                  <li>Reports: {plan.reportsLevel}</li>
                  <li>
                    Features: {[
                      plan.smsEnabled && "SMS",
                      plan.emailEnabled && "Email",
                      plan.certificateEnabled && "Certificates",
                    ]
                      .filter(Boolean)
                      .join(", ") || "none"}
                  </li>
                </ul>
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "1rem" }}>
            <button type="button" onClick={() => setStep(2)}>
              Back
            </button>
            <button type="button" onClick={() => setStep(4)} disabled={!canAdvanceFromPlan()}>
              Next: Subscription dates
            </button>
          </div>
        </section>
      )}

      {step === 4 && (
        <section>
          <h2>Subscription dates</h2>
          <label style={fieldLabelStyle}>
            <input
              type="checkbox"
              checked={form.startTrial}
              onChange={(e) => update("startTrial", e.target.checked)}
            />{" "}
            Start with a trial period
          </label>
          {form.startTrial && (
            <label style={fieldLabelStyle}>
              Trial length (days)
              <input
                type="number"
                style={inputStyle}
                min={1}
                max={365}
                value={form.trialDays}
                onChange={(e) => update("trialDays", e.target.value)}
                required
              />
            </label>
          )}
          <p style={{ color: "#555" }}>
            {form.startTrial
              ? canAdvanceFromSubscriptionDates()
                ? `Subscription starts today in Trial status, for ${form.trialDays} day(s), unless activated sooner.`
                : "Enter a valid trial length (1-365 days) to continue."
              : "Subscription starts today in Draft status — activation happens separately, once onboarding is complete."}
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" onClick={() => setStep(3)}>
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep(5)}
              disabled={!canAdvanceFromSubscriptionDates()}
            >
              Next: Review
            </button>
          </div>
        </section>
      )}

      {step === 5 && (
        <section>
          <h2>Review</h2>
          <ul>
            <li>
              <strong>Academy:</strong> {form.name} ({form.defaultCurrency})
            </li>
            <li>
              <strong>Owner:</strong> {form.ownerEmail}
            </li>
            <li>
              <strong>Default branch:</strong> {form.branchName} ({form.branchCode})
            </li>
            <li>
              <strong>Plan:</strong> {selectedPlan?.name ?? "(none selected)"}
            </li>
            <li>
              <strong>Subscription:</strong>{" "}
              {form.startTrial
                ? `Trial, ${form.trialDays} day(s)`
                : "Draft (no trial — activation happens later)"}
            </li>
          </ul>
          <form action={formAction}>
            <input type="hidden" name="name" value={form.name} />
            <input type="hidden" name="defaultCurrency" value={form.defaultCurrency} />
            <input type="hidden" name="type" value={form.type} />
            <input type="hidden" name="address" value={form.address} />
            <input type="hidden" name="phone" value={form.phone} />
            <input type="hidden" name="email" value={form.email} />
            <input type="hidden" name="website" value={form.website} />
            <input type="hidden" name="logoRef" value={form.logoRef} />
            <input type="hidden" name="registrationNumber" value={form.registrationNumber} />
            <input type="hidden" name="primaryContactName" value={form.primaryContactName} />
            <input type="hidden" name="primaryContactPhone" value={form.primaryContactPhone} />
            <input type="hidden" name="ownerEmail" value={form.ownerEmail} />
            <input type="hidden" name="ownerPassword" value={form.ownerPassword} />
            <input type="hidden" name="branchName" value={form.branchName} />
            <input type="hidden" name="branchCode" value={form.branchCode} />
            <input type="hidden" name="branchAddress" value={form.branchAddress} />
            <input type="hidden" name="branchPhone" value={form.branchPhone} />
            <input type="hidden" name="planId" value={form.planId} />
            <input
              type="hidden"
              name="trialDays"
              value={form.startTrial ? form.trialDays : ""}
            />
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" onClick={() => setStep(4)} disabled={pending}>
                Back
              </button>
              <button type="submit" disabled={pending}>
                {pending ? "Registering..." : "Register academy"}
              </button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
