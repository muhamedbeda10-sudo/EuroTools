"use client";

import { useState } from "react";

import { downloadInspectionCsv } from "@/lib/client/export-csv";

/** Builds the export in the page and hands it to the browser.
 *
 *  It reads every inspection, which takes a moment on a plant with real
 *  history, so the button says what it is doing rather than appearing to have
 *  ignored the click.
 */
export function ExportCsvButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="no-print inline-flex flex-col items-start gap-1">
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await downloadInspectionCsv();
          } catch {
            setError("Could not build the file. Check the connection and try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Preparing…" : "Export CSV"}
      </button>
      {error && <span className="text-xs font-semibold text-[var(--bad-fg)]">{error}</span>}
    </span>
  );
}
