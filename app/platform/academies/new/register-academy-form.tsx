"use client";

import { useActionState, useState, type ReactNode } from "react";
import { registerAcademy, type RegisterAcademyState } from "@/lib/academies/register-actions";
import type { SubscriptionPlanRecord } from "@/lib/subscriptions/plans";
import { Badge, Button, ErrorMessage, Field, Section, inputClass } from "@/app/academy/_shell/ui";

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

interface RegisterAcademyFormProps {
  /** Only is_active plans — "only active plans should be selectable at
   * registration time" — filtered by the page (app/platform/academies/new/
   * page.tsx) before this component ever sees the list. */
  activePlans: SubscriptionPlanRecord[];
}

/**
 * Persistent step rail — a real fixed sequence (this wizard has exactly one
 * order, start to finish), so the numbering + connecting line is structural,
 * not decorative. Horizontal + scrollable below `lg`, a proper vertical
 * "you are here" rail at `lg` and up, sitting beside the step content rather
 * than above it.
 */
function StepRail({ step }: { step: number }) {
  return (
    <ol className="flex gap-4 overflow-x-auto pb-2 lg:sticky lg:top-6 lg:flex-col lg:gap-0 lg:overflow-visible lg:pb-0 lg:self-start">
      {STEPS.map((label, index) => {
        const state = index === step ? "current" : index < step ? "done" : "upcoming";
        const isLast = index === STEPS.length - 1;
        return (
          <li key={label} className="flex shrink-0 items-start gap-3 lg:pb-7 lg:last:pb-0">
            <div className="flex flex-col items-center">
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  state === "current"
                    ? "bg-navy text-white"
                    : state === "done"
                      ? "bg-success text-white"
                      : "border border-border-strong bg-surface text-muted"
                }`}
              >
                {state === "done" ? "✓" : index + 1}
              </span>
              {!isLast && <span aria-hidden="true" className="mt-1 hidden w-px flex-1 bg-border lg:block" style={{ minHeight: 28 }} />}
            </div>
            <span
              className={`whitespace-nowrap pt-1 text-sm lg:whitespace-normal ${
                state === "current" ? "font-semibold text-ink" : state === "done" ? "text-ink" : "text-muted"
              }`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
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

function StepFooter({
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
}: {
  onBack?: () => void;
  onNext: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
}) {
  return (
    <div className="mt-8 flex items-center justify-between border-t border-border pt-6">
      {onBack ? (
        <Button type="button" variant="secondary" onClick={onBack}>
          Back
        </Button>
      ) : (
        <span />
      )}
      <Button type="button" onClick={onNext} disabled={nextDisabled}>
        {nextLabel}
      </Button>
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
    return form.planId.trim().length > 0;
  }

  function canAdvanceFromSubscriptionDates(): boolean {
    if (!form.startTrial) return true;
    const days = Number(form.trialDays);
    return Number.isInteger(days) && days >= 1 && days <= 365;
  }

  const selectedPlan = activePlans.find((plan) => plan.id === form.planId);

  return (
    <div className="lg:grid lg:grid-cols-[200px_1fr] lg:gap-10">
      <StepRail step={step} />

      <div className="mt-6 min-w-0 lg:mt-0">
        {state.error && (
          <div className="mb-4">
            <ErrorMessage message={state.error.message} />
          </div>
        )}

        {step === 0 && (
          <Section>
            <h2 className="text-base font-semibold text-ink">Academy profile</h2>
            <p className="mt-1 text-sm text-muted">The basic identity of the academy you&apos;re setting up.</p>

            <div className="mt-6 flex flex-col gap-6">
              <FieldGroup title="Identity" first>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
                  <Field label="Academy name">
                    <input
                      className={inputClass}
                      value={form.name}
                      onChange={(e) => update("name", e.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Currency">
                    <input
                      className={inputClass}
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
                    className={inputClass}
                    value={form.type}
                    placeholder="e.g. Training institute, coding bootcamp"
                    onChange={(e) => update("type", e.target.value)}
                  />
                </Field>
              </FieldGroup>

              <FieldGroup title="Contact">
                <Field label="Address">
                  <input className={inputClass} value={form.address} onChange={(e) => update("address", e.target.value)} />
                </Field>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Phone">
                    <input className={inputClass} value={form.phone} onChange={(e) => update("phone", e.target.value)} />
                  </Field>
                  <Field label="Email">
                    <input
                      type="email"
                      className={inputClass}
                      value={form.email}
                      onChange={(e) => update("email", e.target.value)}
                    />
                  </Field>
                </div>
                <Field label="Website">
                  <input className={inputClass} value={form.website} onChange={(e) => update("website", e.target.value)} />
                </Field>
              </FieldGroup>

              <FieldGroup title="Registration details">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Logo">
                    <input
                      className={inputClass}
                      value={form.logoRef}
                      onChange={(e) => update("logoRef", e.target.value)}
                      placeholder="Uploaded file reference"
                    />
                  </Field>
                  <Field label="Registration number">
                    <input
                      className={inputClass}
                      value={form.registrationNumber}
                      onChange={(e) => update("registrationNumber", e.target.value)}
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Primary contact name">
                    <input
                      className={inputClass}
                      value={form.primaryContactName}
                      onChange={(e) => update("primaryContactName", e.target.value)}
                    />
                  </Field>
                  <Field label="Primary contact phone">
                    <input
                      className={inputClass}
                      value={form.primaryContactPhone}
                      onChange={(e) => update("primaryContactPhone", e.target.value)}
                    />
                  </Field>
                </div>
              </FieldGroup>
            </div>

            <StepFooter onNext={() => setStep(1)} nextLabel="Next: Owner account" nextDisabled={!canAdvanceFromProfile()} />
          </Section>
        )}

        {step === 1 && (
          <Section>
            <h2 className="text-base font-semibold text-ink">Owner account</h2>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted">
              This creates the academy&apos;s first sign-in, with the <Badge label="academy_owner" tone="blue" /> role.
            </p>
            <div className="mt-6 flex max-w-md flex-col gap-3">
              <Field label="Owner email">
                <input
                  type="email"
                  className={inputClass}
                  value={form.ownerEmail}
                  onChange={(e) => update("ownerEmail", e.target.value)}
                  required
                />
              </Field>
              <Field label="Temporary password">
                <input
                  type="password"
                  className={inputClass}
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
              nextLabel="Next: Default branch"
              nextDisabled={!canAdvanceFromOwner()}
            />
          </Section>
        )}

        {step === 2 && (
          <Section>
            <h2 className="text-base font-semibold text-ink">Default branch</h2>
            <p className="mt-1 text-sm text-muted">Every academy starts with one branch — more can be added later.</p>
            <div className="mt-6 flex flex-col gap-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
                <Field label="Branch name">
                  <input
                    className={inputClass}
                    value={form.branchName}
                    onChange={(e) => update("branchName", e.target.value)}
                    required
                  />
                </Field>
                <Field label="Branch code">
                  <input
                    className={inputClass}
                    value={form.branchCode}
                    onChange={(e) => update("branchCode", e.target.value.toUpperCase())}
                    required
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Branch address">
                  <input
                    className={inputClass}
                    value={form.branchAddress}
                    onChange={(e) => update("branchAddress", e.target.value)}
                  />
                </Field>
                <Field label="Branch phone">
                  <input
                    className={inputClass}
                    value={form.branchPhone}
                    onChange={(e) => update("branchPhone", e.target.value)}
                  />
                </Field>
              </div>
            </div>
            <StepFooter
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
              nextLabel="Next: Plan & allowances"
              nextDisabled={!canAdvanceFromBranch()}
            />
          </Section>
        )}

        {step === 3 && (
          <Section>
            <h2 className="text-base font-semibold text-ink">Plan &amp; allowances</h2>
            <p className="mt-1 text-sm text-muted">
              A plan must be chosen now — new academies always start with one. Only active plans are offered.
            </p>
            {activePlans.length === 0 && (
              <div className="mt-4">
                <ErrorMessage message="No active subscription plans exist yet. Create one at /platform/plans before registering an academy." />
              </div>
            )}
            <div className="mt-6 flex flex-col gap-3">
              {activePlans.map((plan) => {
                const selected = form.planId === plan.id;
                const features = [plan.smsEnabled && "SMS", plan.emailEnabled && "Email", plan.certificateEnabled && "Certificates"].filter(
                  Boolean,
                );
                return (
                  <label
                    key={plan.id}
                    className={`block cursor-pointer rounded-card border p-5 transition-colors ${
                      selected ? "border-brand bg-info-bg" : "border-border bg-surface hover:border-border-strong"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="planChoice"
                        value={plan.id}
                        checked={selected}
                        onChange={() => update("planId", plan.id)}
                        className="mt-1.5 h-4 w-4 accent-brand"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          <span className="font-semibold text-ink">{plan.name}</span>
                          <span className="text-lg font-bold text-ink">
                            {formatPrice(plan.priceAmountCents, plan.currency)}{" "}
                            <span className="text-xs font-normal text-muted">/ {plan.billingPeriod}</span>
                          </span>
                        </div>
                        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
                          <div className="flex justify-between gap-2 sm:block">
                            <dt className="text-xs text-muted">Branches</dt>
                            <dd className="font-medium text-ink">{plan.maxBranches}</dd>
                          </div>
                          <div className="flex justify-between gap-2 sm:block">
                            <dt className="text-xs text-muted">Students</dt>
                            <dd className="font-medium text-ink">{plan.maxStudents}</dd>
                          </div>
                          <div className="flex justify-between gap-2 sm:block">
                            <dt className="text-xs text-muted">Staff</dt>
                            <dd className="font-medium text-ink">{plan.maxStaff}</dd>
                          </div>
                          <div className="flex justify-between gap-2 sm:block">
                            <dt className="text-xs text-muted">Courses</dt>
                            <dd className="font-medium text-ink">{plan.maxCourses}</dd>
                          </div>
                          <div className="flex justify-between gap-2 sm:block">
                            <dt className="text-xs text-muted">Storage</dt>
                            <dd className="font-medium text-ink">{formatBytes(plan.maxStorageBytes)}</dd>
                          </div>
                          <div className="flex justify-between gap-2 sm:block">
                            <dt className="text-xs text-muted">Reports</dt>
                            <dd className="font-medium capitalize text-ink">{plan.reportsLevel}</dd>
                          </div>
                        </dl>
                        <p className="mt-3 text-xs text-muted">
                          {features.length > 0 ? `Includes ${features.join(", ")}.` : "No optional features included."}
                        </p>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            <StepFooter
              onBack={() => setStep(2)}
              onNext={() => setStep(4)}
              nextLabel="Next: Subscription dates"
              nextDisabled={!canAdvanceFromPlan()}
            />
          </Section>
        )}

        {step === 4 && (
          <Section>
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
                    className={inputClass}
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
              nextLabel="Next: Review"
              nextDisabled={!canAdvanceFromSubscriptionDates()}
            />
          </Section>
        )}

        {step === 5 && (
          <Section>
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
              <div className="mt-8 flex items-center justify-between border-t border-border pt-6">
                <Button type="button" variant="secondary" onClick={() => setStep(4)} disabled={pending}>
                  Back
                </Button>
                <Button type="submit" disabled={pending} className="px-6">
                  {pending ? "Registering..." : "Register academy"}
                </Button>
              </div>
            </form>
          </Section>
        )}
      </div>
    </div>
  );
}
