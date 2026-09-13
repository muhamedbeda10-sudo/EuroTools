"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Async } from "@/components/Async";
import { FilterBar } from "@/components/FilterBar";
import { PrintButton } from "@/components/PrintButton";
import { PrintHeader } from "@/components/PrintHeader";
import { ImportPanel } from "@/components/ImportPanel";
import { InlineForm } from "@/components/InlineForm";
import { PasteGrid, emptyRow, type GridColumn, type GridRow } from "@/components/PasteGrid";
import { BoxIcon, PencilIcon, UploadIcon } from "@/components/icons";
import { ActionForm } from "@/components/ActionForm";
import { Card, Empty } from "@/components/ui";
import { allows } from "@/lib/domain/roles";
import { facetValues, matchesFacet, matchesText } from "@/lib/filter";
import { fmtDate } from "@/lib/format";
import { PLANNING_COLUMNS, parsePlanning, type PlanningRow } from "@/lib/import/parse";
import { cancelPlanningLine, importPlanning, updatePlanningLine } from "@/lib/client/actions";
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
        {(lines) => <Lines me={me} lines={lines} refresh={state.refresh} />}
      </Async>
    </>
  );
}

type Line = Awaited<ReturnType<typeof getPlanningLines>>[number];

/** Everything planning has brought in, and the ways of getting at one row.
 *
 *  Filtering happens here rather than in the query. A Firestore read per
 *  keystroke would spend the day's allowance on typing; these rows are already
 *  in hand and bounded by the query's own limit.
 */
function Lines({ me, lines, refresh }: { me: SessionUser; lines: Line[]; refresh: () => void }) {
  const mayPlan = allows(me, "planning.manage");
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState("");
  const [measuring, setMeasuring] = useState("");
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const shown = useMemo(
    () =>
      lines.filter(
        (l) =>
          matchesText([l.project, l.mplpr, l.itemCode, l.itemName], query) &&
          matchesFacet(l.priority, priority) &&
          matchesFacet(l.measuringType, measuring) &&
          matchesFacet(lineIsComplete(l.counts) ? "Complete" : "With quality", status)
      ),
    [lines, query, priority, measuring, status]
  );

  const columns = 13 + (mayPlan ? 1 : 0);
  const shownIsFiltered = shown.length !== lines.length;

  return (
    <>
      <PrintHeader
        title="Planning lines"
        subtitle={
          shownIsFiltered
            ? `${shown.length} of ${lines.length} lines — filtered`
            : `${lines.length} line(s)`
        }
        by={me.displayName}
      />

      <Card
        className="rise"
        title="Lines"
        action={
          <span className="flex items-center gap-2">
            <span className="pill pill-neutral">{lines.length}</span>
            <PrintButton label="Print" />
          </span>
        }
      >
      <FilterBar
        query={query}
        onQuery={setQuery}
        placeholder="Search a project, an MPLPR, an item or a name…"
        noun="line"
        showing={shown.length}
        total={lines.length}
        facets={[
          {
            key: "priority",
            label: "Priority",
            options: facetValues(lines, (l) => l.priority),
            value: priority,
            onChange: setPriority,
          },
          {
            key: "measuring",
            label: "Measuring",
            options: facetValues(lines, (l) => l.measuringType),
            value: measuring,
            onChange: setMeasuring,
          },
          {
            key: "status",
            label: "Status",
            options: ["With quality", "Complete"],
            value: status,
            onChange: setStatus,
          },
        ]}
      />

      {lines.length === 0 ? (
        <Empty>No lines yet.</Empty>
      ) : shown.length === 0 ? (
        <Empty>No line matches the filter.</Empty>
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
                {mayPlan && <th className="no-print" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((l) =>
                editing === l.id ? (
                  <tr key={l.id}>
                    <td colSpan={columns} className="bg-[var(--brand-light)] p-3">
                      <EditLine
                        me={me}
                        line={l}
                        onClose={() => setEditing(null)}
                        onSaved={() => {
                          setEditing(null);
                          refresh();
                        }}
                      />
                    </td>
                  </tr>
                ) : (
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
                    {mayPlan && (
                      <td className="no-print">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            className="btn btn-icon"
                            title={`Edit ${l.project} ${l.itemCode}`}
                            onClick={() => setEditing(l.id)}
                          >
                            <PencilIcon />
                          </button>
                          {l.counts.measurements === 0 ? (
                            <InlineForm
                              action={cancelPlanningLine(me)}
                              onSuccess={refresh}
                              submitLabel="Delete"
                              submitClassName="btn-danger"
                              confirm={`Delete ${l.project} ${l.itemCode} and its ${l.qty} piece(s)? Nothing has been measured yet.`}
                            >
                              <input type="hidden" name="lineId" value={l.id} />
                            </InlineForm>
                          ) : (
                            <span className="text-xs text-[var(--muted)]">started</span>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>
      )}
      </Card>
    </>
  );
}

/** Correcting one line, in the row it lives in.
 *
 *  The project, the item and the planned date are shown but not offered: the
 *  line's identity is built from those three, so changing one is not a
 *  correction to this line but a different line altogether. Deleting and
 *  adding says that plainly, where an editable field would have implied
 *  something the system cannot do.
 */
function EditLine({
  me,
  line,
  onClose,
  onSaved,
}: {
  me: SessionUser;
  line: Line;
  onClose: () => void;
  onSaved: () => void;
}) {
  const measured = line.counts.measurements > 0;

  return (
    <ActionForm
      action={updatePlanningLine(me)}
      submitLabel="Save"
      onSuccess={onSaved}
      secondary={
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
      }
    >
      <input type="hidden" name="lineId" value={line.id} />

      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="ltr font-bold">{line.project}</span>
        <span className="text-[var(--muted)]">·</span>
        <span className="ltr font-semibold">{line.itemCode}</span>
        <span className="num text-[var(--muted)]">{fmtDate(line.plannedAt)}</span>
        <span className="text-xs text-[var(--muted)]">
          — delete the line and add it again to change these
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="MPLPR">
          <input className="input ltr w-28" name="mplpr" defaultValue={line.mplpr ?? ""} />
        </Field>
        <Field label="Name">
          <input className="input w-56" name="itemName" defaultValue={line.itemName} required />
        </Field>
        <Field label="Qty" hint={measured ? "fixed once measured" : undefined}>
          <input
            className="input num w-20"
            name="qty"
            type="number"
            min={1}
            defaultValue={line.qty}
            readOnly={measured}
            required
          />
        </Field>
        <Field label="Measuring">
          <select className="select" name="measuringType" defaultValue={line.measuringType}>
            <option value="CMM">CMM</option>
            <option value="Traditional">Traditional</option>
          </select>
        </Field>
        <Field label="Priority">
          <input className="input ltr w-20" name="priority" defaultValue={line.priority ?? ""} />
        </Field>
      </div>
    </ActionForm>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-[var(--muted)]">
        {label}
        {hint && <span className="ms-1 font-normal">({hint})</span>}
      </span>
      {children}
    </label>
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
    <div className="no-print mb-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Card
        className="rise"
        title={
          <span className="inline-flex items-center gap-2">
            <BoxIcon /> New lines
          </span>
        }
        subtitle="Type or paste from the planning sheet"
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
