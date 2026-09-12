"use client";

import Link from "next/link";
import { useState } from "react";

import { Async } from "@/components/Async";
import { ImportPanel } from "@/components/ImportPanel";
import { InlineForm } from "@/components/InlineForm";
import { PasteGrid, emptyRow, type GridColumn, type GridRow } from "@/components/PasteGrid";
import { BoxIcon, UploadIcon } from "@/components/icons";
import { Card, Empty } from "@/components/ui";
import { allows } from "@/lib/domain/roles";
import { fmtDate } from "@/lib/format";
import { PLANNING_COLUMNS, parsePlanning, type PlanningRow } from "@/lib/import/parse";
import { cancelPlanningLine, importPlanning } from "@/lib/client/actions";
import { getPlanningLines } from "@/lib/client/queries";
import { lineIsComplete } from "@/lib/model";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession, type SessionUser } from "@/lib/client/session";

/** The grid mirrors the sheet's own columns, so a block copied out of Excel
 *  lands in the right places without anybody rearranging it first. */
const COLUMNS: GridColumn[] = [
  { key: "project", label: "Project", width: 14, placeholder: "MM260001" },
  { key: "mplpr", label: "MPLPR", width: 8, placeholder: "MP" },
  { key: "item", label: "Item", width: 12, placeholder: "Core" },
  { key: "name", label: "Name", width: 16, placeholder: "Core insert" },
  { key: "qty", label: "Qty", width: 6, numeric: true },
  { key: "measuring", label: "Measuring type", options: ["CMM", "Traditional"] },
  { key: "date", label: "Date", width: 12, placeholder: "12/09/2026" },
  { key: "priority", label: "Priority", width: 8, placeholder: "A" },
];

const HEADERS = ["Project", "MPLPR", "Item", "Name", "Qty", "Measuring type", "Date", "Priority"];

export default function PlanningPage() {
  const me = useRequireSession();
  const state = useAsync(() => getPlanningLines(), []);
  if (!me) return null;

  return (
    <>
      {allows(me, "planning.manage") && <Entry me={me} onSaved={state.refresh} />}

      <Async state={state}>
        {(lines) => (
          <Card
            className="rise"
            title="Lines"
            action={<span className="pill pill-neutral">{lines.length}</span>}
          >
            {lines.length === 0 ? (
              <Empty>No lines yet. Type or paste a few above, or bring in a sheet.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>MPLPR</th>
                      <th>Item</th>
                      <th>Name</th>
                      <th>Qty</th>
                      <th>Measuring</th>
                      <th>Priority</th>
                      <th>Planned</th>
                      <th>With QC</th>
                      <th>Rework</th>
                      <th>Closed</th>
                      <th>Measured</th>
                      <th>Complete</th>
                      {allows(me, "planning.manage") && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.id}>
                        <td className="ltr font-bold">
                          <Link href={`/planning/line/?id=${l.id}`} className="text-[var(--brand)]">
                            {l.project}
                          </Link>
                        </td>
                        <td className="ltr">{l.mplpr ?? "—"}</td>
                        <td className="ltr">{l.itemCode}</td>
                        <td>{l.itemName}</td>
                        <td className="num">{l.qty}</td>
                        <td>{l.measuringType === "CMM" ? "CMM" : "Traditional"}</td>
                        <td className="ltr">{l.priority ?? "—"}</td>
                        <td className="num whitespace-nowrap">{fmtDate(l.plannedAt)}</td>
                        <td className="num">{l.counts.withQc}</td>
                        <td className="num">{l.counts.inRework}</td>
                        <td className="num">{l.counts.closed}</td>
                        <td className="num">{l.counts.measurements}</td>
                        <td>
                          {lineIsComplete(l.counts) ? (
                            <span className="pill pill-ok">Complete</span>
                          ) : (
                            <span className="pill pill-info">With quality</span>
                          )}
                        </td>
                        {allows(me, "planning.manage") && (
                          <td>
                            {l.counts.measurements === 0 ? (
                              <InlineForm
                                action={cancelPlanningLine(me)}
                                onSuccess={state.refresh}
                                submitLabel="Cancel"
                                submitClassName="btn-danger"
                                confirm={`Cancel ${l.project} ${l.itemCode} and its ${l.qty} piece(s)? Nothing has been measured yet.`}
                              >
                                <input type="hidden" name="lineId" value={l.id} />
                              </InlineForm>
                            ) : (
                              <span className="text-xs text-[var(--muted)]">started</span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </Async>
    </>
  );
}

/** Two ways in, one set of rules.
 *
 *  The grid hands its rows to the same parser the file import uses, so a line
 *  typed here and a line read out of an .xlsx are checked against exactly the
 *  same thing. There is no second, looser path for what somebody types.
 */
function Entry({ me, onSaved }: { me: SessionUser; onSaved: () => void }) {
  const [rows, setRows] = useState<GridRow[]>(() => [emptyRow(COLUMNS)]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const filled = rows.filter((r) => Object.values(r).some((v) => v.trim() !== ""));

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const grid = [HEADERS, ...filled.map((r) => COLUMNS.map((c) => r[c.key] ?? ""))];
      const parsed = parsePlanning(grid);

      if (parsed.problems.length > 0) {
        setMessage({
          tone: "bad",
          text: parsed.problems
            .slice(0, 4)
            .map((p) => `Row ${p.row - 1}: ${p.message}`)
            .join(" · "),
        });
        return;
      }

      const outcome = await importPlanning(me)(parsed.rows);
      setMessage({
        tone: outcome.ok ? "ok" : "bad",
        text: outcome.info ?? outcome.error ?? "",
      });
      if (outcome.ok) {
        setRows([emptyRow(COLUMNS)]);
        onSaved();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Card
        className="rise"
        title={
          <span className="inline-flex items-center gap-2">
            <BoxIcon /> New lines
          </span>
        }
        subtitle="Type them, or paste a block straight out of the planning sheet"
      >
        <PasteGrid columns={COLUMNS} rows={rows} onChange={setRows} />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || filled.length === 0}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : `Save ${filled.length || ""} line(s)`.replace("  ", " ")}
          </button>
          {message && (
            <span
              className={`text-sm ${
                message.tone === "ok" ? "text-[var(--ok-fg)]" : "text-[var(--bad-fg)]"
              }`}
            >
              {message.text}
            </span>
          )}
        </div>
      </Card>

      <Card
        className="rise"
        title={
          <span className="inline-flex items-center gap-2">
            <UploadIcon /> From a file
          </span>
        }
      >
        <ImportPanel<PlanningRow>
          title="Each row becomes a line, and its quantity becomes that many pieces."
          columns={PLANNING_COLUMNS}
          parse={parsePlanning}
          commit={(r) => importPlanning(me)(r)}
          onDone={onSaved}
          describe={(r) => `${r.project} · ${r.itemCode} · ${r.qty} pcs · ${r.measuringType}`}
        />
      </Card>
    </div>
  );
}
