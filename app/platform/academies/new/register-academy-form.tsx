"use client";

import { useActionState, useState, type CSSProperties } from "react";
import {
  registerAcademy,
  REGISTER_ACADEMY_INITIAL_STATE,
} from "@/lib/academies/register-actions";

// DESIGN.md §8 /platform/academies/new: "Pattern C (multi-step). Steps:
// Academy profile ... -> Owner account -> Default branch -> Plan +
// allowances -> Subscription dates -> Review." The last two steps assign a
// subscription plan and dates — that's createAcademySubscription, wired in
// by Item 24 (PLAN.md Item list), a later item than this one (Item 20:
// registerAcademy only creates the academy/branch/owner). This form
// therefore implements the first three data-collecting steps plus a Review
// step, and hands off to the academy's own page for plan/subscription setup
// afterwards (register-actions.ts redirects to /platform/academies/[id] on
// success, an Item 21 page).
const STEPS = ["Academy profile", "Owner account", "Default branch", "Review"] as const;

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
};

const fieldLabelStyle: CSSProperties = { display: "block", marginBottom: "0.75rem" };
const inputStyle: CSSProperties = { display: "block", width: "100%", marginTop: "0.25rem" };

export function RegisterAcademyForm() {
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
              Next: Review
            </button>
          </div>
        </section>
      )}

      {step === 3 && (
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
          </ul>
          <p style={{ color: "#555" }}>
            Plan assignment and subscription setup happen next, on the academy&apos;s
            own page, once it&apos;s created.
          </p>
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
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button type="button" onClick={() => setStep(2)} disabled={pending}>
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
