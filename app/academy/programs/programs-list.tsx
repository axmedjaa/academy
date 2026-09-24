"use client";

import { useActionState } from "react";
import {
  createProgram,
  deleteProgram,
  setProgramStatus,
  type ProgramFormState,
} from "@/lib/academies/programs-actions";
import type { ProgramDeletionEligibilitySummary, ProgramRecord } from "@/lib/academies/programs";
import { Badge, Button, ErrorMessage, Field, Section, TableWrap, inputClass, td, th, trHover } from "@/app/academy/_shell/ui";
import { ConfirmButton, EligibilityGatedDeleteButton } from "@/app/academy/_shell/confirm-dialog";

const initialState: ProgramFormState = { ok: false };

interface Props {
  programs: (ProgramRecord & { deletionEligibility: ProgramDeletionEligibilitySummary })[];
  canManage: boolean;
}

export function ProgramsList({ programs, canManage }: Props) {
  const [createState, createFormAction, creating] = useActionState(createProgram, initialState);

  function toggleProgramStatus(program: ProgramRecord) {
    return setProgramStatus(program.id, program.status === "active" ? "archived" : "active");
  }

  return (
    <section className="flex flex-col gap-6">
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
          {programs.length === 0 ? (
            <tr>
              <td colSpan={canManage ? 4 : 3} className={`${td} text-center text-muted`}>
                No programs to show yet.
              </td>
            </tr>
          ) : (
            programs.map((program) => (
              <tr key={program.id} className={trHover}>
                <td className={`${td} font-medium`}>{program.name}</td>
                <td className={td}>{program.description ?? "—"}</td>
                <td className={td}>
                  <Badge label={program.status} tone={program.status === "archived" ? "gray" : "green"} />
                </td>
                {canManage && (
                  <td className={td}>
                    <div className="flex flex-wrap gap-2">
                    <ConfirmButton
                      label={program.status === "active" ? "Archive" : "Restore"}
                      variant={program.status === "active" ? "danger" : "secondary"}
                      className="px-2.5 py-1 text-xs"
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
                    <EligibilityGatedDeleteButton
                      entityLabel="Program"
                      entityName={program.name}
                      eligible={program.deletionEligibility.eligible}
                      reasons={program.deletionEligibility.reasons}
                      onConfirm={() => deleteProgram(program.id, program.name)}
                    />
                    </div>
                  </td>
                )}
              </tr>
            ))
          )}
        </tbody>
      </TableWrap>

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
