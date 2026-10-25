"use client";

import { startTransition, useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { updateAcademySettings, type AcademySettingsFormState } from "@/lib/academies/settings-actions";
import type { AcademySettingsRecord } from "@/lib/academies/settings";
import { guardAction } from "@/lib/ui/guard-action";
import { showSuccessToast } from "@/lib/ui/toast";
import { Button } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import {
  DField,
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  PhoneField,
  controlClass,
  invalidProps,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";

const guardedUpdate = guardAction(updateAcademySettings);
const initialState: AcademySettingsFormState = { ok: false };

const RULES: DesignFormRule[] = [
  { name: "name", label: "Academy name", required: true },
  {
    name: "email",
    label: "Email",
    check: (value) => (!value.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : "Enter a valid email address, for example hello@academy.so."),
  },
];

/**
 * Edit profile (design `profile` form): the academy's own profile fields
 * through the existing `updateAcademySettings` action (direct edit, no
 * approval step, audited). Slug and default currency are not editable and
 * are not offered here.
 */
export function EditProfileButton({ academy }: { academy: AcademySettingsRecord }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-2">
        <Icon name="settings" width={18} height={18} />
        Edit profile
      </Button>
      <DesignDialog open={open} onOpenChange={setOpen} title="Edit academy profile" description="Slug and currency cannot be changed." width={640}>
        {open && (
          <ProfileForm
            academy={academy}
            onCancel={() => setOpen(false)}
            onSaved={() => {
              setOpen(false);
              router.refresh();
            }}
          />
        )}
      </DesignDialog>
    </>
  );
}

function ProfileForm({ academy, onCancel, onSaved }: { academy: AcademySettingsRecord; onCancel: () => void; onSaved: () => void }) {
  const [state, formAction, pending] = useActionState(guardedUpdate, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(RULES);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast("Academy profile saved.");
      onSaved();
    } else if (state.error) {
      showServerError(state.error.message, [
        [/name/i, "name"],
        [/email/i, "email"],
        [/website|url/i, "website"],
        [/phone/i, "phone"],
      ]);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const text = (name: keyof AcademySettingsRecord, label: string, placeholder?: string, full?: boolean) => (
    <DField label={label} name={name} error={errors[name]} full={full}>
      <input
        type="text"
        name={name}
        defaultValue={(academy[name] as string | null) ?? ""}
        placeholder={placeholder}
        maxLength={300}
        onBlur={blur(name)}
        className={controlClass(Boolean(errors[name]))}
        {...invalidProps(name, errors[name])}
      />
    </DField>
  );

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      <DialogBody>
        <FieldGrid>
          <DField label="Academy name" name="name" required error={errors.name} full>
            <input
              type="text"
              name="name"
              defaultValue={academy.name}
              maxLength={200}
              onBlur={blur("name")}
              className={controlClass(Boolean(errors.name))}
              {...invalidProps("name", errors.name)}
            />
          </DField>
          {text("type", "Type", "Training institute")}
          {text("registrationNumber", "Registration number")}
          {text("address", "Address", "Hargeisa, Somalia", true)}
          <DField label="Phone" name="phone" error={errors.phone}>
            <PhoneField name="phone" defaultValue={academy.phone} error={errors.phone} />
          </DField>
          <DField label="Email" name="email" error={errors.email}>
            <input
              type="email"
              name="email"
              defaultValue={academy.email ?? ""}
              placeholder="hello@academy.so"
              onBlur={blur("email")}
              className={controlClass(Boolean(errors.email))}
              {...invalidProps("email", errors.email)}
            />
          </DField>
          {text("website", "Website", "academy.so", true)}
          {text("primaryContactName", "Primary contact name")}
          <DField label="Primary contact phone" name="primaryContactPhone">
            <PhoneField name="primaryContactPhone" defaultValue={academy.primaryContactPhone} />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onCancel} submitLabel="Save" pendingLabel="Saving…" pending={pending} />
    </form>
  );
}
