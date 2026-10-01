"use client";

import { useActionState, useState } from "react";
import {
  createProgram,
  deleteProgram,
  setProgramStatus,
  type ProgramFormState,
} from "@/lib/academies/programs-actions";
import type { ProgramDeletionEligibilitySummary, ProgramRecord } from "@/lib/academies/programs";
import { Badge, Button, EmptyState, ErrorMessage, Field, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { Icon } from "@/app/academy/_shell/icons";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const initialState: ProgramFormState = { ok: false };

interface Props {
  programs: (ProgramRecord & { deletionEligibility: ProgramDeletionEligibilitySummary })[];
  canManage: boolean;
}

export function ProgramsList({ programs, canManage }: Props) {
  const [createState, createFormAction, creating] = useActionState(createProgram, initialState);
  // Which row's Archive/Restore or Delete confirmation is open — the
  // dropdown menu item opens it externally (ConfirmButton's controlled
  // mode), same pattern as app/academy/students/students-list.tsx.
  const [archiveRowId, setArchiveRowId] = useState<string | null>(null);
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null);

  function toggleProgramStatus(program: ProgramRecord) {
    return setProgramStatus(program.id, program.status === "active" ? "archived" : "active");
  }

  return (
    <section className="flex flex-col gap-6">
      {programs.length === 0 ? (
        <Section>
          <EmptyState message="No programs to show yet." icon={<Icon name="school" />} />
        </Section>
      ) : (
      <TableWrap>
        <thead>
          <tr>
            <th className={th}>Name</th>
            <th className={th}>Description</th>
            <th className={th}>Status</th>
            {canManage && <th className={th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
            {programs.map((program) => (
              <tr key={program.id} className={trHover}>
                <td className={`${td} font-medium`}>{program.name}</td>
                <td className={td}>{program.description ?? "—"}</td>
                <td className={td}>
                  <Badge label={program.status} tone={program.status === "archived" ? "gray" : "green"} />
                </td>
                {canManage && (
                  <td className={td}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Actions for ${program.name}`}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-app hover:text-ink motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                        >
                          <Icon name="more" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setArchiveRowId(program.id)}>
                          {program.status === "active" ? "Archive" : "Restore"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {program.deletionEligibility.eligible ? (
                          <DropdownMenuItem variant="destructive" onClick={() => setDeleteRowId(program.id)}>
                            Delete
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            disabled
                            title={`This program cannot be permanently deleted because ${program.deletionEligibility.reasons.join("; ")}. Use Archive instead.`}
                          >
                            Delete
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <ConfirmButton
                      label={program.status === "active" ? "Archive" : "Restore"}
                      variant={program.status === "active" ? "danger" : "secondary"}
                      open={archiveRowId === program.id}
                      onOpenChange={(nextOpen) => setArchiveRowId(nextOpen ? program.id : null)}
                      title={
                        program.status === "active"
                          ? `Archive "${program.name}"?`
                          : `Restore "${program.name}"?`
                      }
                      description={
                        program.status === "active" ? (
                          <>
                            Archived programs are hidden from course creation, but every course already
                            under this program is kept and can be restored at any time.
                          </>
                        ) : (
                          <>This program will be marked active again and available for new courses.</>
                        )
                      }
                      onConfirm={() => toggleProgramStatus(program)}
                    />
                    {program.deletionEligibility.eligible && (
                      <ConfirmButton
                        label="Delete"
                        variant="dangerSolid"
                        open={deleteRowId === program.id}
                        onOpenChange={(nextOpen) => setDeleteRowId(nextOpen ? program.id : null)}
                        title={`Delete "${program.name}" permanently?`}
                        description={<>This cannot be undone.</>}
                        confirmInput={{ label: `Type "${program.name}" to confirm`, requiredValue: program.name }}
                        onConfirm={() => deleteProgram(program.id, program.name)}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
        </tbody>
      </TableWrap>
      )}

      {canManage && (
        <Section>
          <h2 className="text-base font-semibold text-ink">Add program</h2>
          <form action={createFormAction} className="mt-4 flex max-w-lg flex-col gap-3">
            <Field label="Name">
              <input type="text" name="name" required className={inputClass} />
            </Field>
            <Field label="Description">
              <textarea name="description" rows={3} className={inputClass} />
            </Field>
            {createState.error && <ErrorMessage message={createState.error.message} />}
            {createState.ok && <p className="text-sm font-medium text-success">Program created.</p>}
            <Button type="submit" disabled={creating} className="self-start">
              {creating ? "Creating..." : "Create program"}
            </Button>
          </form>
        </Section>
      )}
    </section>
  );
}
