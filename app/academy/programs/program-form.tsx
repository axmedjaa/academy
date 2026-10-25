"use client";

import { startTransition, useActionState, useEffect } from "react";
import { createProgram, updateProgram, type ProgramFormState } from "@/lib/academies/programs-actions";
import type { ProgramRecord } from "@/lib/academies/programs";
import { showSuccessToast } from "@/lib/ui/toast";
import {
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
import { guardAction } from "@/lib/ui/guard-action";

// Failed requests come back as form errors (see lib/ui/guard-action.ts).
const guardedCreateProgram = guardAction(createProgram);
const guardedUpdateProgram = guardAction(updateProgram);

/**
 * New program / Edit program (design A06 form `program`): Name* and
 * Description on the design's form system. Edit uses the existing
 * `updateProgram` action, which re-checks the caller may manage programs.
 */

const initialState: ProgramFormState = { ok: false };

const RULES: DesignFormRule[] = [
  { name: "name", label: "Name", required: true },
  {
    name: "description",
    label: "Description",
    check: (value) => (value.length > 2000 ? "Keep the description under 2,000 characters." : null),
  },
];

const SERVER_FIELD_PATTERNS: [RegExp, string][] = [
  [/name/i, "name"],
  [/description/i, "description"],
];

function ProgramFields({
  program,
  onCancel,
  onSaved,
}: {
  program: ProgramRecord | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionState(program ? guardedUpdateProgram : guardedCreateProgram, initialState);
  const { formRef, errors, banner, validate, blur, showServerError } = useDesignForm(RULES);

  useEffect(() => {
    if (state.ok) {
      showSuccessToast(program ? "Program updated." : "Program created.");
      onSaved();
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
      {program && <input type="hidden" name="programId" value={program.id} />}
      <DialogBody>
        <FieldGrid>
          <DField label="Name" name="name" required error={errors.name} full>
            <input
              type="text"
              name="name"
              defaultValue={program?.name ?? ""}
              maxLength={200}
              onBlur={blur("name")}
              className={controlClass(Boolean(errors.name))}
              {...invalidProps("name", errors.name)}
            />
          </DField>
          <DField label="Description" name="description" error={errors.description} full>
            <textarea
              name="description"
              rows={3}
              defaultValue={program?.description ?? ""}
              onBlur={blur("description")}
              className={`${controlClass(Boolean(errors.description), true)} min-h-[88px] resize-y`}
              {...invalidProps("description", errors.description)}
            />
          </DField>
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter
        onCancel={onCancel}
        submitLabel={program ? "Save changes" : "Create"}
        pendingLabel={program ? "Saving…" : "Creating…"}
        pending={pending}
      />
    </form>
  );
}

export function ProgramFormDialog({
  open,
  onOpenChange,
  program,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  program: ProgramRecord | null;
  onSaved?: () => void;
}) {
  return (
    <DesignDialog
      open={open}
      onOpenChange={onOpenChange}
      title={program ? "Edit program" : "New program"}
      description={program ? `Courses under ${program.name} keep their place in it.` : undefined}
    >
      {open && (
        <ProgramFields
          key={program?.id ?? "new"}
          program={program}
          onCancel={() => onOpenChange(false)}
          onSaved={() => {
            onOpenChange(false);
            onSaved?.();
          }}
        />
      )}
    </DesignDialog>
  );
}
