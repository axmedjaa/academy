"use client";

import { useState } from "react";
import type { StaffWorkplaceOptions } from "@/lib/academies/staff";
import type { AcademyRole } from "@/lib/auth/roles";
import { ChoiceChips, DField, invalidProps } from "@/app/academy/_shell/design-form";

/**
 * Multi-branch "Where they work" field, shared by Register staff member and
 * the staff list's Edit branches dialog: all branches (owner only) or
 * specific branches — only those the viewer works in are offered. Submits
 * `workplace` and `branchIds`; the server checks the same rules.
 */
export function WorkplaceField({
  options,
  role,
  error,
  defaultWorkplace = "specific",
  defaultBranchIds,
  otherBranchCount = 0,
}: {
  options: StaffWorkplaceOptions;
  role: AcademyRole;
  error?: string;
  defaultWorkplace?: "all" | "specific";
  /** Pre-ticked branches; without it, a viewer's only branch is ticked. */
  defaultBranchIds?: string[];
  /** Branches the person also works in that the viewer doesn't manage; kept as they are. */
  otherBranchCount?: number;
}) {
  const [workplace, setWorkplace] = useState<"all" | "specific">(
    options.canGrantAllBranches ? defaultWorkplace : "specific",
  );

  if (role === "academy_owner") {
    return (
      <DField label="Where they work" name="branchIds" full>
        <span className="text-sm font-normal text-muted">An owner always works across all branches.</span>
      </DField>
    );
  }

  return (
    <DField
      label="Where they work"
      name="branchIds"
      required
      group
      full
      error={error}
      hint={
        workplace === "all"
          ? "Sees and manages every branch, including branches added later. They are placed on the Main Branch."
          : otherBranchCount > 0
            ? `They only see records of their branches. They also work in ${otherBranchCount} other branch${otherBranchCount === 1 ? "" : "es"} you don't manage, which stay as they are.`
            : "They only see students, classes and records of these branches."
      }
    >
      {options.canGrantAllBranches ? (
        <ChoiceChips
          name="workplace"
          defaultValue={workplace}
          onChange={(value) => setWorkplace(value === "all" ? "all" : "specific")}
          options={[
            { value: "specific", label: "Specific branches" },
            { value: "all", label: "All branches" },
          ]}
        />
      ) : (
        <input type="hidden" name="workplace" value="specific" />
      )}
      {workplace === "specific" && (
        <span className="flex flex-wrap gap-2">
          {options.branches.map((branch) => (
            <label
              key={branch.id}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border-strong bg-surface px-3.5 text-sm font-semibold text-ink transition-colors duration-150 hover:bg-app has-[:checked]:border-brand has-[:checked]:bg-brand-tint has-[:checked]:text-brand has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/30"
            >
              <input
                type="checkbox"
                name="branchIds"
                value={branch.id}
                defaultChecked={defaultBranchIds ? defaultBranchIds.includes(branch.id) : options.branches.length === 1}
                className="sr-only"
                {...invalidProps("branchIds", error)}
              />
              {branch.name}
              {branch.isMain && <span className="text-xs font-medium">Main</span>}
            </label>
          ))}
        </span>
      )}
    </DField>
  );
}
