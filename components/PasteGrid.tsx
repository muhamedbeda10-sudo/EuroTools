"use client";

import { useCallback, useRef, useState } from "react";

import { PlusIcon, TrashIcon } from "./icons";

/** A grid you can paste a spreadsheet into.
 *
 *  Typing rows one field at a time is what people avoid by keeping the data in
 *  Excel in the first place. So this behaves the way the thing they are coming
 *  from behaves: select a cell, paste a block, and the block lands where the
 *  cursor is, growing the grid to fit. Copying out of Excel puts tab-separated
 *  rows on the clipboard, which is all this has to understand.
 *
 *  It holds strings and nothing else. What a value *means* — a quantity, a
 *  date, a measuring type — is decided by the same parser the file import
 *  uses, so a row typed here and a row imported from a sheet are checked by
 *  one set of rules rather than two.
 */
export interface GridColumn {
  key: string;
  label: string;
  /** Width hint in characters; the column is still allowed to shrink. */
  width?: number;
  placeholder?: string;
  options?: readonly string[];
  numeric?: boolean;
}

export type GridRow = Record<string, string>;

export const emptyRow = (columns: GridColumn[]): GridRow =>
  Object.fromEntries(columns.map((c) => [c.key, ""]));

/** Tab-separated rows, as every spreadsheet puts them on the clipboard. A
 *  single cell with no tab or newline is left to paste normally. */
export function splitClipboard(text: string): string[][] | null {
  if (!/[\t\n\r]/.test(text)) return null;
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => line.split("\t"));
}

/** Where a pasted block lands, and how far the grid has to grow to hold it. */
export function applyPaste(
  rows: GridRow[],
  columns: GridColumn[],
  block: string[][],
  atRow: number,
  atColumn: number
): GridRow[] {
  const next = rows.map((r) => ({ ...r }));

  for (let r = 0; r < block.length; r += 1) {
    const target = atRow + r;
    while (next.length <= target) next.push(emptyRow(columns));

    for (let c = 0; c < block[r].length; c += 1) {
      const column = columns[atColumn + c];
      // A block wider than the grid is not an error worth refusing: Excel
      // selections pick up trailing empty columns all the time. What falls off
      // the right is dropped.
      if (!column) break;
      next[target][column.key] = block[r][c].trim();
    }
  }

  return next;
}

export function PasteGrid({
  columns,
  rows,
  onChange,
  minRows = 1,
}: {
  columns: GridColumn[];
  rows: GridRow[];
  onChange: (rows: GridRow[]) => void;
  minRows?: number;
}) {
  const [focus, setFocus] = useState<{ row: number; col: number } | null>(null);
  const grid = useRef<HTMLTableSectionElement>(null);

  const set = useCallback(
    (row: number, key: string, value: string) =>
      onChange(rows.map((r, i) => (i === row ? { ...r, [key]: value } : r))),
    [rows, onChange]
  );

  const addRow = () => onChange([...rows, emptyRow(columns)]);

  const removeRow = (at: number) => {
    const next = rows.filter((_, i) => i !== at);
    onChange(next.length >= minRows ? next : [emptyRow(columns)]);
  };

  function onPaste(e: React.ClipboardEvent, row: number, col: number) {
    const block = splitClipboard(e.clipboardData.getData("text/plain"));
    if (!block) return;
    e.preventDefault();
    onChange(applyPaste(rows, columns, block, row, col));
  }

  /** Enter moves down a row, the way it does in a spreadsheet. Tab is left to
   *  the browser, which already moves along the row. */
  function onKeyDown(e: React.KeyboardEvent, row: number, col: number) {
    if (e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    if (row === rows.length - 1) addRow();
    // After the state settles, or the cell being focused does not exist yet.
    requestAnimationFrame(() => {
      const cell = grid.current?.querySelector<HTMLElement>(
        `[data-cell="${row + 1}:${col}"]`
      );
      cell?.focus();
    });
  }

  return (
    <div>
      <div className="scroll-x">
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-10 text-center">#</th>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
              <th className="w-12" />
            </tr>
          </thead>
          <tbody ref={grid}>
            {rows.map((row, r) => (
              <tr key={r} className={focus?.row === r ? "bg-[var(--brand-light)]" : undefined}>
                <td className="num text-center text-xs text-[var(--muted)]">{r + 1}</td>

                {columns.map((column, c) => (
                  <td key={column.key}>
                    {column.options ? (
                      <select
                        className="select"
                        data-cell={`${r}:${c}`}
                        value={row[column.key] ?? ""}
                        onChange={(e) => set(r, column.key, e.target.value)}
                        onFocus={() => setFocus({ row: r, col: c })}
                        onBlur={() => setFocus(null)}
                      >
                        <option value="">—</option>
                        {column.options.map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className={`input ${column.numeric ? "num" : ""}`}
                        style={{ minWidth: `${(column.width ?? 10) * 0.6}rem` }}
                        data-cell={`${r}:${c}`}
                        value={row[column.key] ?? ""}
                        placeholder={column.placeholder}
                        onChange={(e) => set(r, column.key, e.target.value)}
                        onPaste={(e) => onPaste(e, r, c)}
                        onKeyDown={(e) => onKeyDown(e, r, c)}
                        onFocus={() => setFocus({ row: r, col: c })}
                        onBlur={() => setFocus(null)}
                      />
                    )}
                  </td>
                ))}

                <td>
                  <button
                    type="button"
                    className="btn btn-icon"
                    title="Remove this row"
                    onClick={() => removeRow(r)}
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn" onClick={addRow}>
          <PlusIcon /> Add a row
        </button>
        <p className="text-xs text-[var(--muted)]">
          Copy a block out of Excel and paste it into any cell — it fills from
          there and adds rows to fit. Enter moves down, Tab moves across.
        </p>
      </div>
    </div>
  );
}
