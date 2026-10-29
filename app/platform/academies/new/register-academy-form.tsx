"use client";

import { useActionState, useState, type ReactNode } from "react";
import { registerAcademy, type RegisterAcademyState } from "@/lib/academies/register-actions";
import type { SubscriptionPlanRecord } from "@/lib/subscriptions/plans";
import { Badge, ErrorMessage, Field } from "@/app/academy/_shell/ui";
import { controlClass } from "@/app/academy/_shell/design-form";
import { PlanPicker, formatPlanPricePerPeriod } from "./plan-picker";

const fieldInput = controlClass(false);

// DESIGN.md §8 /platform/academies/new: "Pattern C (multi-step). Steps:
// Academy profile ... -> Owner account -> Default branch -> Plan +
// allowances -> Subscription dates -> Review." Item 20 originally deferred
// the last two steps because createAcademySubscription didn't exist yet;
// Item 24 wires it into registerAcademy itself (academy_subscriptions.plan_id
// is NOT NULL with no default), so this form now implements the full
// six-step sequence DESIGN.md describes.
const STEPS = [
  "Academy profile",
  "Owner account",
  "Default branch",
  "Plan & allowances",
  "Subscription dates",
  "Review",
] as const;

const DEFAULT_TRIAL_DAYS = "14";

// Kept local rather than exported from register-actions.ts: a "use server"
// file may only export async functions (Next.js requirement — exporting a
// plain object alongside the action throws "A 'use server' file can only
// export async functions, found object" at build/dev time), so every
// XxxInitialState literal in this codebase lives next to the client
// component that uses it (see e.g. app/academy/courses/courses-list.tsx's
// own local `initialState`), never inside the action file itself.
const REGISTER_ACADEMY_INITIAL_STATE: RegisterAcademyState = { ok: false };

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

interface RegisterAcademyFormProps {
  /** Only is_active plans — "only active plans should be selectable at
   * registration time" — filtered by the page (app/platform/academies/new/
   * page.tsx) before this component ever sees the list. */
  activePlans: SubscriptionPlanRecord[];
}

/**
 * Design wizard header: the burgundy band with the title, "Step N of 6",
 * and a horizontal stepper (done steps ticked, the current one filled).
 * The steps are a real fixed sequence, so the numbering is structural.
 * Scrolls sideways on narrow screens rather than squeezing the labels.
 */
function WizardHeader({ step }: { step: number }) {
  return (
    <div className="border-t-4 border-[#F5B638] bg-brand px-5 pb-5 pt-6 text-center text-white sm:px-8">
      <h1 className="text-[22px] font-bold leading-tight">Register academy</h1>
      <p className="mt-1 text-[13px] text-white/90">
        Step {step + 1} of {STEPS.length}. Nothing is created until you confirm.
      </p>
      <ol className="mt-5 flex justify-between gap-1 overflow-x-auto pb-1" aria-label="Registration steps">
        {STEPS.map((label, index) => {
          const state = index === step ? "current" : index < step ? "done" : "upcoming";
          return (
            <li
              key={label}
              aria-current={state === "current" ? "step" : undefined}
              className="relative flex min-w-[76px] flex-1 flex-col items-center gap-1.5"
            >
              {index > 0 && (
                <span aria-hidden="true" className="absolute right-1/2 top-[14px] w-full border-t-2 border-dashed border-white/50" />
              )}
              <span
                className={`relative flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-xs font-bold ${
                  state === "current" ? "bg-white text-brand" : state === "done" ? "bg-white/90 text-brand" : "bg-brand text-white"
                }`}
              >
                {state === "done" ? "✓" : index + 1}
              </span>
              <span className={`text-[11px] leading-tight sm:text-xs ${state === "current" ? "font-bold" : "font-semibold text-white/90"}`}>{label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Divider + small heading for a field cluster within a long step — real
 * structure (grouping related fields), not a decorative label. */
function FieldGroup({ title, first, children }: { title: string; first?: boolean; children: ReactNode }) {
  return (
    <div className={`flex flex-col gap-3 ${first ? "" : "border-t border-border pt-6"}`}>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {children}
    </div>
  );
}

// Design wizard actions (Platform Console.dc.html, register footer): two
// equal-width buttons, an outlined "Previous step" and a filled primary.
const FOOTER_BUTTON =
  "h-11 min-w-0 flex-1 whitespace-nowrap rounded-lg px-3 font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50";
const PREVIOUS_BUTTON = `${FOOTER_BUTTON} border-[1.5px] border-brand bg-surface text-brand hover:bg-brand-tint`;
const PRIMARY_BUTTON = `${FOOTER_BUTTON} border-0 bg-brand text-white hover:bg-[#6B0014]`;

function StepFooter({
  onBack,
  onNext,
  nextDisabled,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
}) {
  return (
    <div className="mt-7 flex gap-3">
      {onBack && (
        <button type="button" className={PREVIOUS_BUTTON} onClick={onBack}>
          Previous step
        </button>
      )}
      <button type="button" className={PRIMARY_BUTTON} onClick={onNext} disabled={nextDisabled}>
        Continue
      </button>
    </div>
  );
}

/** Design `wzErr`: the reason Continue did not move on. */
function StepError({ message }: { message: string }) {
  return (
    <div role="alert" className="mt-4 flex items-start gap-3 rounded-card border border-[#FECACA] bg-[#FEF2F2] px-3.5 py-3">
      <span aria-hidden="true" className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[#B91C1C] text-[13px] font-bold text-white">
        !
      </span>
      <span className="text-[13px] font-medium leading-normal text-[#7F1D1D]">{message}</span>
    </div>
  );
}

export function RegisterAcademyForm({ activePlans }: RegisterAcademyFormProps) {
  const [state, formAction, pending] = useActionState(
    registerAcademy,
    REGISTER_ACADEMY_INITIAL_STATE,
  );
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(initialFormState);
  const [planError, setPlanError] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function canAdvanceFromProfile(): boolean {
    return form.name.trim().length > 0 && form.defaultCurrency.trim().length === 3;
  }

  function canAdvanceFromOwner(): boolean {
    return form.ownerEmail.trim().length > 0 && form.ownerPassword.length >= 8;
  }

  function canAdvanceFromBranch(): boolean {
    return form.branchName.trim().length > 0 && form.branchCode.trim().length > 0;
  }

  function canAdvanceFromPlan(): boolean {
    return activePlans.some((plan) => plan.id === form.planId);
  }

  function canAdvanceFromSubscriptionDates(): boolean {
    if (!form.startTrial) return true;
    const days = Number(form.trialDays);
    return Number.isInteger(days) && days >= 1 && days <= 365;
  }

  const selectedPlan = activePlans.find((plan) => plan.id === form.planId);

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <WizardHeader step={step} />

      <div className="min-w-0 px-5 py-6 sm:px-8">
        {state.error && (
          <div className="mb-4">
            <ErrorMessage message={state.error.message} />
          </div>
        )}

        {step === 0 && (
          <div>
            <h2 className="text-base font-semibold text-ink">Academy profile</h2>
            <p className="mt-1 text-sm text-muted">The basic identity of the academy you&apos;re setting up.</p>

            <div className="mt-6 flex flex-col gap-6">
              <FieldGroup title="Identity" first>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
                  <Field label="Academy name">
                    <input
                      className={fieldInput}
                      value={form.name}
                      onChange={(e) => update("name", e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Currency">
                    <input
                      className={fieldInput}
                      value={form.defaultCurrency}
                      maxLength={3}
                      placeholder="USD"
                      onChange={(e) => update("defaultCurrency", e.target.value.toUpperCase())}
                      required
                    />
                  </Field>
                </div>
                <Field label="Type">
                  <input
                    className={fieldInput}
                    value={form.type}
                    placeholder="e.g. Training institute, coding bootcamp"
                    onChange={(e) => update("type", e.target.value)}
                  />
                </Field>
              </FieldGroup>

              <FieldGroup title="Contact">
                <Field label="Address">
                  <input className={fieldInput} value={form.address} onChange={(e) => update("address", e.target.value)} />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Phone">
                    <input className={fieldInput} value={form.phone} onChange={(e) => update("phone", e.target.value)} />
                  </Field>
                  <Field label="Email">
                    <input
                      type="email"
                      className={fieldInput}
                      value={form.email}
                      onChange={(e) => update("email", e.target.value)}
                    />
                  </Field>
                </div>
                <Field label="Website">
                  <input className={fieldInput} value={form.website} onChange={(e) => update("website", e.target.value)} />
                </Field>
              </FieldGroup>

              <FieldGroup title="Registration details">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Logo">
                    <input
                      className={fieldInput}
                      value={form.logoRef}
                      onChange={(e) => update("logoRef", e.target.value)}
                      placeholder="Uploaded file reference"
                    />
                  </Field>
                  <Field label="Registration number">
                    <input
                      className={fieldInput}
                      value={form.registrationNumber}
                      onChange={(e) => update("registrationNumber", e.target.value)}
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Primary contact name">
                    <input
                      className={fieldInput}
                      value={form.primaryContactName}
                      onChange={(e) => update("primaryContactName", e.target.value)}
                    />
                  </Field>
                  <Field label="Primary contact phone">
                    <input
                      className={fieldInput}
                      value={form.primaryContactPhone}
                      onChange={(e) => update("primaryContactPhone", e.target.value)}
                    />
                  </Field>
                </div>
              </FieldGroup>
            </div>

            <StepFooter onNext={() => setStep(1)} nextDisabled={!canAdvanceFromProfile()} />
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 className="text-base font-semibold text-ink">Owner account</h2>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted">
              This creates the academy&apos;s first sign-in, with the <Badge label="academy_owner" tone="blue" /> role.
            </p>
            <div className="mt-6 flex max-w-md flex-col gap-3">
              <Field label="Owner email">
                <input
                  type="email"
                  className={fieldInput}
                  value={form.ownerEmail}
                  onChange={(e) => update("ownerEmail", e.target.value)}
                  required
                />
              </Field>
              <Field label="Temporary password">
                <input
                  type="password"
                  className={fieldInput}
                  value={form.ownerPassword}
                  minLength={8}
                  onChange={(e) => update("ownerPassword", e.target.value)}
                  required
                />
              </Field>
              <p className="text-xs text-muted">
                At least 8 characters. Share it with the customer through a secure channel — it won&apos;t be shown again
                after this.
              </p>
            </div>
            <StepFooter
              onBack={() => setStep(0)}
              onNext={() => setStep(2)}
              nextDisabled={!canAdvanceFromOwner()}
            />
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-base font-semibold text-ink">Default branch</h2>
            <p className="mt-1 text-sm text-muted">Every academy starts with one branch — more can be added later.</p>
            <div className="mt-6 flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
                <Field label="Branch name">
                  <input
                    className={fieldInput}
                    value={form.branchName}
                    onChange={(e) => update("branchName", e.target.value)}
                    required
                  />
                </Field>
                <Field label="Branch code">
                  <input
                    className={fieldInput}
                    value={form.branchCode}
                    onChange={(e) => update("branchCode", e.target.value.toUpperCase())}
                    required
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Branch address">
                  <input
                    className={fieldInput}
                    value={form.branchAddress}
                    onChange={(e) => update("branchAddress", e.target.value)}
                  />
                </Field>
                <Field label="Branch phone">
                  <input
                    className={fieldInput}
                    value={form.branchPhone}
                    onChange={(e) => update("branchPhone", e.target.value)}
                  />
                </Field>
              </div>
            </div>
            <StepFooter
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
              nextDisabled={!canAdvanceFromBranch()}
            />
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 className="text-base font-semibold text-ink">Plan and allowances</h2>
            <p className="mt-1 text-sm text-muted">Choose a plan. Allowances come from the plan.</p>
            {activePlans.length === 0 && (
              <div className="mt-4">
                <ErrorMessage message="No active subscription plans exist yet. Create one at /platform/plans before registering an academy." />
              </div>
            )}
            {planError && <StepError message={planError} />}
            {activePlans.length > 0 && (
              <div className="mt-5">
                <PlanPicker
                  plans={activePlans}
                  value={form.planId}
                  onChange={(planId) => {
                    update("planId", planId);
                    setPlanError(null);
                  }}
                />
              </div>
            )}
            <StepFooter
              onBack={() => {
                setPlanError(null);
                setStep(2);
              }}
              onNext={() => {
                if (canAdvanceFromPlan()) {
                  setPlanError(null);
                  setStep(4);
                } else {
                  setPlanError("Choose a plan to continue.");
                }
              }}
            />
          </div>
        )}

        {step === 4 && (
          <div>
            <h2 className="text-base font-semibold text-ink">Subscription dates</h2>
            <p className="mt-1 text-sm text-muted">Decide whether this academy starts on a trial or in draft.</p>

            <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-card border border-border bg-app/60 p-4">
              <input
                type="checkbox"
                checked={form.startTrial}
                onChange={(e) => update("startTrial", e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-brand"
              />
              <span>
                <span className="block text-sm font-medium text-ink">Start with a trial period</span>
                <span className="mt-0.5 block text-xs text-muted">
                  Recommended — the customer gets full access immediately, no separate activation step needed.
                </span>
              </span>
            </label>

            {form.startTrial && (
              <div className="mt-4 max-w-[220px]">
                <Field label="Trial length (days)">
                  <input
                    type="number"
                    className={fieldInput}
                    min={1}
                    max={365}
                    value={form.trialDays}
                    onChange={(e) => update("trialDays", e.target.value)}
                    required
                  />
                </Field>
              </div>
            )}

            <p className="mt-4 text-sm text-muted">
              {form.startTrial
                ? canAdvanceFromSubscriptionDates()
                  ? `Subscription starts today in Trial status, for ${form.trialDays} day(s), unless activated sooner.`
                  : "Enter a valid trial length (1-365 days) to continue."
                : "Subscription starts today in Draft status — activation happens separately, once onboarding is complete."}
            </p>

            <StepFooter
              onBack={() => setStep(3)}
              onNext={() => setStep(5)}
              nextDisabled={!canAdvanceFromSubscriptionDates()}
            />
          </div>
        )}

        {step === 5 && (
          <div>
            <h2 className="text-base font-semibold text-ink">Review</h2>
            <p className="mt-1 text-sm text-muted">Check everything before creating the academy — this can&apos;t be undone.</p>

            <div className="mt-6 flex flex-col gap-5">
              <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
                <div>
                  <div className="text-xs text-muted">Academy</div>
                  <div className="mt-0.5 font-medium text-ink">{form.name}</div>
                  <div className="text-sm text-muted">{form.defaultCurrency}</div>
                </div>
                <button type="button" onClick={() => setStep(0)} className="shrink-0 text-sm text-brand hover:underline">
                  Edit
                </button>
              </div>

              <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
                <div>
                  <div className="text-xs text-muted">Owner</div>
                  <div className="mt-0.5 font-medium text-ink">{form.ownerEmail}</div>
                </div>
                <button type="button" onClick={() => setStep(1)} className="shrink-0 text-sm text-brand hover:underline">
                  Edit
                </button>
              </div>

              <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
                <div>
                  <div className="text-xs text-muted">Default branch</div>
                  <div className="mt-0.5 font-medium text-ink">
                    {form.branchName} <span className="font-normal text-muted">({form.branchCode})</span>
                  </div>
                </div>
                <button type="button" onClick={() => setStep(2)} className="shrink-0 text-sm text-brand hover:underline">
                  Edit
                </button>
              </div>

              <div className="flex items-start justify-between gap-4 border-b border-border pb-4">
                <div>
                  <div className="text-xs text-muted">Plan</div>
                  <div className="mt-0.5 font-medium text-ink">{selectedPlan?.name ?? "(none selected)"}</div>
                  {selectedPlan && (
                    <div className="text-sm text-muted">
                      {formatPlanPricePerPeriod(selectedPlan)}
                    </div>
                  )}
                </div>
                <button type="button" onClick={() => setStep(3)} className="shrink-0 text-sm text-brand hover:underline">
                  Edit
                </button>
              </div>

              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs text-muted">Subscription</div>
                  <div className="mt-0.5 font-medium text-ink">
                    {form.startTrial ? `Trial, ${form.trialDays} day(s)` : "Draft (no trial — activation happens later)"}
                  </div>
                </div>
                <button type="button" onClick={() => setStep(4)} className="shrink-0 text-sm text-brand hover:underline">
                  Edit
                </button>
              </div>
            </div>

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
              <input type="hidden" name="trialDays" value={form.startTrial ? form.trialDays : ""} />
              <div className="mt-7 flex gap-3">
                <button type="button" className={PREVIOUS_BUTTON} onClick={() => setStep(4)} disabled={pending}>
                  Previous step
                </button>
                <button type="submit" className={PRIMARY_BUTTON} disabled={pending}>
                  {pending ? "Registering..." : "Register academy"}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
