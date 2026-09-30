"use client";

import { useMemo, useState } from "react";
import { inputClass } from "@/app/academy/_shell/ui";

export interface StudentPickerOption {
  id: string;
  fullName: string;
  studentNumber: string;
}

interface Props {
  /** Rendered as a hidden `<input name={name}>` so this drops into any
   * existing native `<form action={...}>` (FormData-based server action)
   * exactly like the plain `<select name="studentId">` it replaces. */
  name: string;
  options: StudentPickerOption[];
  value: string;
  onChange: (studentId: string) => void;
  required?: boolean;
  disabled?: boolean;
}

const MAX_VISIBLE_MATCHES = 50;

/**
 * A type-ahead student picker — replaces a plain `<select>` of every active
 * student (previously capped at STUDENTS_MAX_PAGE_SIZE, with no way to find
 * a student past that cap or without scrolling a long list). Filters
 * client-side over the `options` already fetched server-side for the page,
 * so there is no new network round-trip per keystroke; `options` itself is
 * still bounded the same way it always was — this only fixes the *finding*
 * problem, not the underlying page-size cap.
 */
export function StudentPicker({ name, options, value, onChange, required, disabled }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.id === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches =
      q === ""
        ? options
        : options.filter(
            (option) => option.fullName.toLowerCase().includes(q) || option.studentNumber.toLowerCase().includes(q),
          );
    return matches.slice(0, MAX_VISIBLE_MATCHES);
  }, [options, query]);

  return (
    <div className="relative">
      <input type="hidden" name={name} value={value} required={required} />
      <input
        type="text"
        disabled={disabled}
        className={inputClass}
        value={open ? query : (selected ? `${selected.fullName} (${selected.studentNumber})` : "")}
        placeholder={options.length === 0 ? "No active students yet" : "Search by name or student #…"}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(event) => setQuery(event.target.value)}
        onBlur={() => {
          // Deferred so a click on a dropdown option (which also blurs this
          // input) still registers before the dropdown unmounts.
          setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && (
        <div className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-control border border-border bg-surface shadow-card">
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted">No matches.</p>
          ) : (
            filtered.map((option) => (
              <button
                key={option.id}
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-app"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(option.id);
                  setOpen(false);
                  setQuery("");
                }}
              >
                {option.fullName} ({option.studentNumber})
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
