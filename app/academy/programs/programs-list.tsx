"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { deleteProgram, setProgramStatus } from "@/lib/academies/programs-actions";
import type { ProgramDeletionEligibilitySummary, ProgramRecord } from "@/lib/academies/programs";
import { Badge, Button, EmptyState, PageHeader, Section, trHover } from "@/app/academy/_shell/ui";
import { DataTable, NoteBlock, rtTd, rtTh } from "@/app/academy/_shell/page-blocks";
import { Icon } from "@/app/academy/_shell/icons";
import { ConfirmButton } from "@/app/academy/_shell/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProgramFormDialog } from "./program-form";

/**
 * Programs (design A06): header with New program, the Program /
 * Description / Courses / Status table with Archive or Restore per row, and
 * the delete-rule note. New and Edit use the design form dialog; Edit is
 * wired to the existing `updateProgram` action.
 */

const ROW_BTN =
  "inline-flex h-10 items-center whitespace-nowrap rounded-lg border border-border-strong bg-surface px-3.5 text-[13px] font-semibold text-ink transition-colors duration-150 hover:bg-app disabled:opacity-50";

interface Props {
  programs: (ProgramRecord & { courseCount: number; deletionEligibility: ProgramDeletionEligibilitySummary })[];
  canManage: boolean;
}

export function ProgramsList({ programs, canManage }: Props) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Which row's Archive/Restore or Delete confirmation is open — the
  // dropdown menu item opens it externally (ConfirmButton's controlled
  // mode), same pattern as app/academy/students/students-list.tsx.
  const [archiveRowId, setArchiveRowId] = useState<string | null>(null);
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null);
  const editingProgram = programs.find((program) => program.id === editingId) ?? null;

  function toggleProgramStatus(program: ProgramRecord) {
    return setProgramStatus(program.id, program.status === "active" ? "archived" : "active");
  }

  return (
    <section className="flex flex-col">
      <PageHeader
        title="Programs"
        description="Groups of related courses."
        actions={
          canManage ? (
            <Button type="button" onClick={() => setCreateOpen(true)}>
              New program
            </Button>
          ) : undefined
        }
      />

      {programs.length === 0 ? (
        <Section>
          <EmptyState message={canManage ? "No programs yet. Create one to group related courses." : "No programs to show yet."} icon={<Icon name="school" />} />
        </Section>
      ) : (
        <DataTable stackBelow={760}>
          <thead>
            <tr>
              <th className={rtTh}>Program</th>
              <th className={rtTh}>Description</th>
              <th className={rtTh}>Courses</th>
              <th className={rtTh}>Status</th>
              {canManage && <th className={rtTh}><span className="sr-only">Actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {programs.map((program) => (
              <tr key={program.id} className={trHover}>
                <td className={`${rtTd} font-semibold`} data-label="Program">
                  {program.name}
                </td>
                <td className={rtTd} data-label="Description">
                  {program.description ?? <span className="text-muted">No description</span>}
                </td>
                <td className={`${rtTd} tabular-nums`} data-label="Courses">
                  {program.courseCount}
                </td>
                <td className={rtTd} data-label="Status">
                  <Badge label={program.status} tone={program.status === "archived" ? "gray" : "green"} />
                </td>
                {canManage && (
                  <td className={rtTd} data-actions="">
                    <span className="inline-flex items-center gap-2">
                      <button type="button" onClick={() => setArchiveRowId(program.id)} className={ROW_BTN}>
                        {program.status === "active" ? "Archive" : "Restore"}
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`More actions for ${program.name}`}
                            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-app hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                          >
                            <Icon name="more" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditingId(program.id)}>Edit</DropdownMenuItem>
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
                    </span>

                    <ConfirmButton
                      label={program.status === "active" ? "Archive" : "Restore"}
                      variant={program.status === "active" ? "danger" : "success"}
                      icon={program.status === "active" ? "archive" : "autorenew"}
                      open={archiveRowId === program.id}
                      onOpenChange={(nextOpen) => setArchiveRowId(nextOpen ? program.id : null)}
                      title={program.status === "active" ? `Archive "${program.name}"?` : `Restore "${program.name}"?`}
                      description={
                        program.status === "active" ? (
                          <>
                            Archived programs are hidden from course creation, but every course already under this
                            program is kept and can be restored at any time.
                          </>
                        ) : (
                          <>This program will be marked active again and available for new courses.</>
                        )
                      }
                      successMessage={program.status === "active" ? "Program archived." : "Program restored."}
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
                        successMessage="Program deleted."
                        onConfirm={() => deleteProgram(program.id, program.name)}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      <NoteBlock>Delete is blocked while a course is attached to the program; archive it instead.</NoteBlock>

      {canManage && (
        <>
          <ProgramFormDialog open={createOpen} onOpenChange={setCreateOpen} program={null} onSaved={() => router.refresh()} />
          <ProgramFormDialog
            open={editingProgram !== null}
            onOpenChange={(next) => !next && setEditingId(null)}
            program={editingProgram}
            onSaved={() => router.refresh()}
          />
        </>
      )}
    </section>
  );
}
