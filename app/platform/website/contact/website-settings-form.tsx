"use client";

import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { saveWebsiteSettings } from "@/lib/marketing/website-actions";
import {
  SOCIAL_NETWORKS,
  cleanText,
  toPublicContact,
  websiteSettingsSchema,
  type WebsiteSettingsValues,
} from "@/lib/marketing/website-settings-schema";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showErrorToast, showSuccessToast } from "@/lib/ui/toast";
import { DField, FormErrorBanner, controlClass, invalidProps } from "@/app/academy/_shell/design-form";
import { Section } from "@/app/academy/_shell/ui";
import { ContactSection, FooterContact } from "@/app/_landing/contact-section";

type TextKey = Exclude<keyof WebsiteSettingsValues, "contactFormEnabled">;
type Draft = Record<TextKey, string> & { contactFormEnabled: boolean };

function toDraft(values: WebsiteSettingsValues): Draft {
  const draft = { contactFormEnabled: values.contactFormEnabled } as Draft;
  for (const key of Object.keys(values) as (keyof WebsiteSettingsValues)[]) {
    if (key !== "contactFormEnabled") draft[key] = values[key] ?? "";
  }
  return draft;
}

/** Draft -> values for the preview: trimmed, empty -> hidden, no validation. */
function previewValues(draft: Draft): WebsiteSettingsValues {
  const values = { contactFormEnabled: draft.contactFormEnabled } as WebsiteSettingsValues;
  for (const key of Object.keys(draft) as (keyof Draft)[]) {
    if (key !== "contactFormEnabled") values[key] = cleanText(draft[key]) || null;
  }
  return values;
}

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

function Group({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Section className="mb-6">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <p className="mt-1 mb-5 text-sm text-muted">{description}</p>
      {children}
    </Section>
  );
}

const GRID = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-4";

/**
 * Platform -> Website settings -> Contact information. The browser runs the
 * same Zod schema the server re-checks (lib/marketing/website-settings-
 * schema.ts); the save action enforces platform-owner access itself.
 */
export function WebsiteSettingsForm({
  initial,
  updatedAt,
  updatedByEmail,
}: {
  initial: WebsiteSettingsValues;
  updatedAt: string | null;
  updatedByEmail: string | null;
}) {
  const [saved, setSaved] = useState<Draft>(() => toDraft(initial));
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState({ at: updatedAt, by: updatedByEmail });
  const [pending, startTransition] = useTransition();

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
  const preview = useMemo(() => toPublicContact(previewValues(draft)), [draft]);

  // Unsaved changes: warn before leaving the page or following an in-app link.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const onClick = (event: MouseEvent) => {
      const link = (event.target as HTMLElement | null)?.closest("a[href]");
      if (!link || link.getAttribute("target") === "_blank" || event.defaultPrevented) return;
      if (!window.confirm("You have unsaved changes to the website settings. Leave without saving?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty]);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    if (errors[key]) {
      setErrors((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  function validateAll(): boolean {
    const parsed = websiteSettingsSchema.safeParse(draft);
    if (parsed.success) {
      setErrors({});
      setBanner(null);
      return true;
    }
    const next: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !next[key]) next[key] = issue.message;
    }
    setErrors(next);
    const total = Object.keys(next).length;
    setBanner(total > 1 ? `${total} fields need attention. They are marked below.` : null);
    window.setTimeout(() => document.querySelector<HTMLElement>("[aria-invalid=true]")?.focus(), 40);
    return false;
  }

  function onSave(event: React.FormEvent) {
    event.preventDefault();
    if (!validateAll()) return;
    startTransition(async () => {
      try {
        const result = await saveWebsiteSettings(draft);
        if (!result.ok) {
          if (result.error.field) setErrors({ [result.error.field]: result.error.message });
          else setBanner(result.error.message);
          showErrorToast(result.error.message);
          return;
        }
        const next = toDraft(result.settings.values);
        setSaved(next);
        setDraft(next);
        setLastSaved({ at: result.settings.updatedAt ? new Date(result.settings.updatedAt).toISOString() : null, by: result.settings.updatedByEmail });
        showSuccessToast("Website settings saved. The public website shows them now.");
      } catch {
        setBanner(NETWORK_ERROR_MESSAGE);
        showErrorToast(NETWORK_ERROR_MESSAGE);
      }
    });
  }

  function onDiscard() {
    setDraft(saved);
    setErrors({});
    setBanner(null);
  }

  const text = (key: TextKey, label: string, opts: { type?: string; placeholder?: string; hint?: string; autoComplete?: string; full?: boolean } = {}) => (
    <DField label={label} name={`ws-${key}`} error={errors[key]} hint={opts.hint} full={opts.full}>
      <input
        name={key}
        type={opts.type ?? "text"}
        value={draft[key]}
        placeholder={opts.placeholder}
        autoComplete={opts.autoComplete ?? "off"}
        onChange={(event) => set(key, event.target.value)}
        className={controlClass(Boolean(errors[key]))}
        {...invalidProps(`ws-${key}`, errors[key])}
      />
    </DField>
  );

  const area = (key: TextKey, label: string, hint: string) => (
    <DField label={label} name={`ws-${key}`} error={errors[key]} hint={hint} full>
      <textarea
        name={key}
        rows={3}
        value={draft[key]}
        onChange={(event) => set(key, event.target.value)}
        className={`${controlClass(Boolean(errors[key]), true)} resize-y`}
        {...invalidProps(`ws-${key}`, errors[key])}
      />
    </DField>
  );

  return (
    <>
      <form noValidate onSubmit={onSave} aria-label="Website contact settings">
        <fieldset disabled={pending} className="m-0 min-w-0 border-0 p-0">
          <Group title="Contact details" description="How visitors reach the Dardar team.">
            <div className={GRID}>
              {text("supportEmail", "Support email", { type: "email", hint: "Also receives a notification for each website message when email sending is set up." })}
              {text("phone", "Phone number", { type: "tel", hint: "Include the country code, e.g. +252 …" })}
              {text("whatsappNumber", "WhatsApp number", { type: "tel", hint: "International format. Visitors get a WhatsApp chat link." })}
              {area("officeAddress", "Office address", "Shown as written; line breaks are kept.")}
            </div>
          </Group>

          <Group title="Business hours" description="When the team is available, in your own words.">
            {area("businessHours", "Business hours", "For example, the days and times you answer messages.")}
          </Group>

          <Group title="Social media" description="Links open in a new tab. Each must be an https link on that network's own website.">
            <div className={GRID}>
              {SOCIAL_NETWORKS.map((network) =>
                text(network.key, network.label, { type: "url", placeholder: `https://${network.hosts[0]}/…` }),
              )}
            </div>
          </Group>

          <Group
            title="Contact form"
            description="Messages are stored for review under Contact messages. Visitors are only told their message was received."
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <span className="text-sm text-ink">Show the contact form on the website</span>
              <button
                type="button"
                role="switch"
                aria-checked={draft.contactFormEnabled}
                aria-label="Show the contact form on the website"
                onClick={() => set("contactFormEnabled", !draft.contactFormEnabled)}
                className="group inline-flex min-h-11 shrink-0 items-center gap-2.5 text-[13px] font-semibold text-[#374151] disabled:cursor-not-allowed"
              >
                {draft.contactFormEnabled ? "On" : "Off"}
                <span
                  aria-hidden="true"
                  className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-150 ${draft.contactFormEnabled ? "bg-brand" : "bg-[#CBD5E1]"}`}
                >
                  <span
                    className={`absolute top-0.5 left-0 h-5 w-5 rounded-full bg-white shadow transition-transform duration-150 motion-reduce:transition-none ${
                      draft.contactFormEnabled ? "translate-x-[22px]" : "translate-x-0.5"
                    }`}
                  />
                </span>
              </button>
            </div>
          </Group>

          <FormErrorBanner message={banner} />

          <div className="sticky bottom-0 z-10 -mx-4 mb-8 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-app/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-card sm:border sm:px-5">
            <span className="text-sm text-muted" aria-live="polite">
              {dirty
                ? "You have unsaved changes."
                : lastSaved.at
                  ? `Last saved ${formatWhen(lastSaved.at)}${lastSaved.by ? ` by ${lastSaved.by}` : ""}.`
                  : "Not saved yet. The website shows no contact details."}
            </span>
            <span className="flex gap-2">
              <button
                type="button"
                onClick={onDiscard}
                disabled={!dirty || pending}
                className="h-11 rounded-lg border border-border-strong bg-surface px-4 text-sm font-semibold text-ink hover:bg-app disabled:cursor-not-allowed disabled:opacity-50"
              >
                Discard changes
              </button>
              <button
                type="submit"
                disabled={!dirty || pending}
                className="h-11 rounded-lg bg-brand px-5 text-sm font-semibold text-white hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? "Saving…" : "Save changes"}
              </button>
            </span>
          </div>
        </fieldset>
      </form>

      <section aria-labelledby="ws-preview-title" className="mb-8">
        <h2 id="ws-preview-title" className="text-base font-semibold text-ink">
          Preview
        </h2>
        <p className="mt-1 mb-4 text-sm text-muted">How the Contact section and footer look with the values above, before saving.</p>
        <div className="overflow-hidden rounded-card border border-border bg-app">
          {preview.supportEmail ||
          preview.phone ||
          preview.whatsappUrl ||
          preview.officeAddress ||
          preview.businessHours ||
          preview.socials.length > 0 ||
          preview.contactFormEnabled ? (
            <>
              <ContactSection contact={preview} preview />
              <div className="bg-ink px-6 py-8 text-[#D1D5DB]">
                <FooterContact contact={preview} />
              </div>
            </>
          ) : (
            <p className="p-6 text-sm text-muted">Nothing is set, so the website shows no Contact section.</p>
          )}
        </div>
      </section>
    </>
  );
}
