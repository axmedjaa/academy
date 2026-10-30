"use client";

import { startTransition, useActionState, useEffect } from "react";
import { createBranch, updateBranch, type BranchFormState } from "@/lib/academies/branches-actions";
import type { BranchRecord } from "@/lib/academies/branches";
import { showSuccessToast } from "@/lib/ui/toast";
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
import { guardAction } from "@/lib/ui/guard-action";

// Failed requests come back as form errors (see lib/ui/guard-action.ts).
const guardedCreateBranch = guardAction(createBranch);
const guardedUpdateBranch = guardAction(updateBranch);

/**
 * Add branch / Edit branch (design A05 form `branch`): Name*, Code*,
 * Address, Phone, on the design's form system. The server uppercases the
 * code, enforces its uniqueness per academy and checks the plan's branch
 * allowance on create; those errors land on the matching field.
 */

const initialState: BranchFormState = { ok: false };

const RULES: DesignFormRule[] = [
  { name: "name", label: "Name", required: true },
  {
    name: "code",
    label: "Code",
    required: true,
    check: (value) => (value.trim().length > 30 ? "Use 30 characters or fewer for the code." : null),
  },
];

const SERVER_FIELD_PATTERNS: [RegExp, string][] = [
  [/code/i, "code"],
  [/name/i, "name"],
  [/phone/i, "phone"],
  [/address/i, "address"],
];

function BranchFields({
  branch,
  onCancel,
  onSaved,
}: {
  branch: BranchRecord | null;
  onCancel: () => void;
  /** `branchId` is set for a newly created branch. */
  onSaved: (branchId?: string) => void;
}) {
  const [state, formAction, pending] = useActionState(branch ? guardedUpdateBranch : guardedCreateBranch, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(RULES);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast(branch ? "Branch updated." : "Branch added.");
      onSaved(state.branchId);
    } else if (state.error) {
      showServerError(state.error.message, SERVER_FIELD_PATTERNS);
    }
    // Re-run only for a new action result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={onDesignSubmit(validate, (data) => startTransition(() => formAction(data)))}
    >
      {branch && <input type="hidden" name="branchId" value={branch.id} />}
      <DialogBody>
        <FieldGrid fill>
          <DField label="Name" name="name" required error={errors.name} full>
            <input
              type="text"
              name="name"
              defaultValue={branch?.name ?? ""}
              maxLength={200}
              onBlur={blur("name")}
              className={controlClass(Boolean(errors.name))}
              {...invalidProps("name", errors.name)}
            />
          </DField>
          <DField label="Code" name="code" required error={errors.code}>
            <input
              type="text"
              name="code"
              defaultValue={branch?.code ?? ""}
              maxLength={30}
              autoCapitalize="characters"
              onBlur={blur("code")}
              className={`${controlClass(Boolean(errors.code))} uppercase placeholder:normal-case`}
              {...invalidProps("code", errors.code)}
            />
          </DField>
          <DField label="Address" name="address" error={errors.address} full>
            <input
              type="text"
              name="address"
              defaultValue={branch?.address ?? ""}
              maxLength={500}
              autoComplete="street-address"
              className={controlClass(Boolean(errors.address))}
              {...invalidProps("address", errors.address)}
            />
          </DField>
          <DField label="Phone" name="phone" error={errors.phone}>
            <PhoneField name="phone" defaultValue={branch?.phone} error={errors.phone} />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={onCancel}
        submitLabel={branch ? "Save changes" : "Add branch"}
        pendingLabel={branch ? "Saving…" : "Adding…"}
        pending={pending}
      />
    </form>
  );
}

/** Add branch when `branch` is null, Edit branch otherwise. */
export function BranchFormDialog({
  open,
  onOpenChange,
  branch,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: BranchRecord | null;
  onSaved?: (branchId?: string) => void;
}) {
  return (
    <DesignDialog
      open={open}
      onOpenChange={onOpenChange}
      title={branch ? "Edit branch" : "Add branch"}
      description={
        branch
          ? `Change the details of ${branch.name}. The code is uppercased automatically.`
          : "Adds a regular branch under this academy (the Main Branch stays as it is). The code is uppercased automatically. Next you'll assign its staff."
      }
    >
      {open && (
        <BranchFields
          key={branch?.id ?? "new"}
          branch={branch}
          onCancel={() => onOpenChange(false)}
          onSaved={(branchId) => {
            onOpenChange(false);
            onSaved?.(branchId);
          }}
        />
      )}
    </DesignDialog>
  );
}
