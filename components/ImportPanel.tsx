"use client";

import { useState } from "react";

import { readGrid } from "@/lib/client/spreadsheet";
import type { Parsed, Problem } from "@/lib/import/parse";

/** Bringing a spreadsheet in, in two steps on purpose.
 *
 *  The file is read and checked first, and what it found is shown before
 *  anything is written: how many rows are good, and every row that is not,
 *  named by its line number. An import that silently dropped the four rows it
 *  could not read would create the wrong number of pieces, and nobody would
 *  find out until the count on the bench disagreed with the count on screen.
 *
 *  Nothing is written until somebody looks at that and presses the second
 *  button.
 */
export function ImportPanel<T>({
  title,
  columns,
  parse,
  commit,
  onDone,
  describe,
}: {
  title: string;
  /** The headings the sheet is expected to carry, shown before anybody picks a
   *  file so a mismatch is fixed in Excel rather than discovered here. */
  columns: string[];
  parse: (grid: unknown[][]) => Parsed<T>;
  commit: (rows: T[]) => Promise<{ ok: boolean; error?: string; info?: string }>;
  onDone: () => void;
  describe: (row: T) => string;
}) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<T[] | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  async function choose(file: File | undefined) {
    setMessage(null);
    setRows(null);
    setProblems([]);
    if (!file) return;

    setFileName(file.name);
    setBusy(true);
    try {
      const parsed = parse(await readGrid(file));
      setRows(parsed.rows);
      setProblems(parsed.problems);
    } catch (error) {
      setMessage({ tone: "bad", text: String((error as Error)?.message ?? "That file could not be read.") });
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!rows || rows.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await commit(rows);
      setMessage({
        tone: outcome.ok ? "ok" : "bad",
        text: outcome.info ?? outcome.error ?? (outcome.ok ? "Done." : "That did not work."),
      });
      if (outcome.ok) {
        setRows(null);
        setFileName(null);
        onDone();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-[var(--muted)]">
        {title} Expected headings:{" "}
        <span className="ltr font-semibold">{columns.join(" · ")}</span>. Column order does not
        matter, and extra columns are ignored. <code>.xlsx</code> or <code>.csv</code>.
      </p>

      <input
        className="input"
        type="file"
        accept=".xlsx,.xlsm,.csv,text/csv"
        disabled={busy}
        onChange={(e) => void choose(e.target.files?.[0])}
      />

      {rows && (
        <div className="rounded-[var(--radius-sm)] border border-[var(--border-strong)] p-3">
          <p className="text-sm">
            <strong>{fileName}</strong> — {rows.length} row(s) ready
            {problems.length > 0 && (
              <span className="text-[var(--bad-fg)]">, {problems.length} that cannot be read</span>
            )}
            .
          </p>

          {problems.length > 0 && (
            <ul className="mt-2 grid gap-0.5 text-xs text-[var(--bad-fg)]">
              {problems.slice(0, 8).map((p) => (
                <li key={`${p.row}-${p.message}`}>• Row {p.row}: {p.message}</li>
              ))}
              {problems.length > 8 && <li>• …and {problems.length - 8} more</li>}
            </ul>
          )}

          {rows.length > 0 && (
            <ul className="mt-2 grid gap-0.5 text-xs text-[var(--muted)]">
              {rows.slice(0, 5).map((r, i) => (
                <li key={i} className="ltr">• {describe(r)}</li>
              ))}
              {rows.length > 5 && <li>• …and {rows.length - 5} more</li>}
            </ul>
          )}

          <button
            type="button"
            className="btn btn-primary mt-3"
            disabled={busy || rows.length === 0}
            onClick={() => void send()}
          >
            {busy ? "Bringing it in…" : `Bring in ${rows.length} row(s)`}
          </button>
        </div>
      )}

      {message && (
        <p
          className={`rounded-[var(--radius-sm)] p-2.5 text-sm ${
            message.tone === "ok"
              ? "bg-[var(--ok-bg)] text-[var(--ok-fg)]"
              : "bg-[var(--bad-bg)] text-[var(--bad-fg)]"
          }`}
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
