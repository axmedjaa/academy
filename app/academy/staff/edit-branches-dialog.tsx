"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setStaffWorkplace } from "@/lib/academies/staff-branch-assignments-actions";
import type { StaffListRow, StaffWorkplaceOptions } from "@/lib/academies/staff";
import { NETWORK_ERROR_MESSAGE } from "@/lib/ui/guard-action";
import { showSuccessToast } from "@/lib/ui/toast";
import {
  DesignDialog,
  DialogBody,
  DialogFooter,
  FieldGrid,
  FormErrorBanner,
  onDesignSubmit,
  useDesignForm,
  type DesignFormRule,
} from "@/app/academy/_shell/design-form";
import { WorkplaceField } from "./workplace-field";

const RULES: DesignFormRule[] = [
  {
    name: "branchIds",
    label: "Branches",
    check: (_value, data) =>
      data.get("workplace") === "specific" && data.getAll("branchIds").length === 0
        ? "Choose at least one branch where this person works."
        : null,
  },
];

/**
 * Staff list "Edit branches": where an existing staff member works — all
 * branches (owner only) or specific branches. `setStaffWorkplace` applies
 * it in one transaction with the same rules as the branch Staff tab, and
 * never touches the person's role, status or account.
 */
export function EditBranchesDialog({
  row,
  options,
  open,
  onOpenChange,
}: {
  row: StaffListRow;
  options: StaffWorkplaceOptions;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DesignDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Where ${row.fullName} works`}
      description="Changes take effect the next time they open a page."
    >
      {open && row.role && <EditBranchesForm row={row} options={options} onDone={() => onOpenChange(false)} />}
    </DesignDialog>
  );
}

function EditBranchesForm({ row, options, onDone }: { row: StaffListRow; options: StaffWorkplaceOptions; onDone: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const { formRef, errors, banner, validate, showServerError } = useDesignForm(RULES);

  function submit(data: FormData) {
    const workplace = data.get("workplace") === "all" ? "all" : "specific";
    const branchIds = data.getAll("branchIds").map(String);
    startTransition(async () => {
      try {
        const result = await setStaffWorkplace(row.id, { workplace, branchIds });
        if (!result.ok) {
          showServerError(result.error.message, [[/branch/i, "branchIds"]]);
          return;
        }
        showSuccessToast("Branches updated.");
        onDone();
        router.refresh();
      } catch {
        showServerError(NETWORK_ERROR_MESSAGE, []);
      }
    });
  }

  return (
    <form ref={formRef} noValidate className="flex min-h-0 flex-1 flex-col" onSubmit={onDesignSubmit(validate, submit)}>
      <DialogBody>
        <FieldGrid>
          <WorkplaceField
            options={options}
            role={row.role ?? "trainer"}
            error={errors.branchIds}
            defaultWorkplace={row.allBranchAccess ? "all" : "specific"}
            defaultBranchIds={row.branches.map((branch) => branch.id)}
            otherBranchCount={row.otherBranchCount}
          />
        </FieldGrid>
        <FormErrorBanner message={banner} />
      </DialogBody>
      <DialogFooter onCancel={onDone} submitLabel="Save" pendingLabel="Saving…" pending={pending} />
    </form>
  );
}
