"use client";

import { useMemo, useState } from "react";

import { ActionForm } from "./ActionForm";
import { PhotoField } from "./PhotoField";
import { StatusPill } from "./ui";
import { allows } from "@/lib/domain/roles";
import { result, suggest, type Reading } from "@/lib/domain/measurement";
import { STAGE_LABELS, VERDICTS, VERDICT_LABELS, type Verdict } from "@/lib/domain/workflow";

import type { ActionResult } from "@/lib/client/actions";
import type { DefectSpec, DimensionSpec } from "@/lib/model";
import type { SessionUser } from "@/lib/client/session";

/** The sheet an inspector fills in.
 *
 *  The verdict is worked out here from the readings as they are typed, by the
 *  same function the action re-runs before it writes — so what the inspector
 *  is shown before signing and what the record says afterwards cannot differ.
 *  Choosing anything other than the suggestion is a concession, and the button
 *  for it only exists for an account that may grant one.
 */
interface Row extends DimensionSpec {
  actual: string;
  adHoc: boolean;
}

interface Ticked extends DefectSpec {
  seen: boolean;
  note: string;
  chosenDepartment: string;
}

export function InspectionSheet({
  me,
  pieceId,
  serial,
  stage,
  round,
  dimensions,
  defects,
  departments,
  itemConfigured,
  action,
  onSuccess,
}: {
  me: SessionUser;
  pieceId: string;
  serial: string;
  stage: "ROUGHING" | "FINISH";
  round: number;
  dimensions: DimensionSpec[];
  defects: DefectSpec[];
  departments: string[];
  itemConfigured: boolean;
  action: (formData: FormData) => Promise<ActionResult>;
  onSuccess: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    dimensions.map((d) => ({ ...d, actual: "", adHoc: false }))
  );
  const [ticks, setTicks] = useState<Ticked[]>(() =>
    defects.map((d) => ({ ...d, seen: false, note: "", chosenDepartment: d.department ?? "" }))
  );
  const [chosen, setChosen] = useState<Verdict | "">("");
  const [department, setDepartment] = useState("");

  const suggestion = useMemo(() => {
    const readings: Reading[] = rows.map((r) => ({
      key: r.key,
      name: r.name,
      unit: r.unit,
      nominal: r.nominal,
      tolMinus: r.tolMinus,
      tolPlus: r.tolPlus,
      actual: r.actual.trim() === "" ? null : Number(r.actual),
    }));
    return suggest(
      readings,
      ticks.filter((t) => t.seen).map((t) => ({ key: t.key, name: t.name, department: t.chosenDepartment || null }))
    );
  }, [rows, ticks]);

  const verdict: Verdict = chosen || suggestion.verdict;
  const mayBypass = allows(me, "verdict.bypass");
  const isConcession = verdict !== "HOLD" && suggestion.verdict === "HOLD";
  const holdDepartment = department || suggestion.department || "";

  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, at) => (at === i ? { ...r, ...patch } : r)));

  const addRow = () =>
    setRows((rs) => [
      ...rs,
      {
        key: `adhoc_${rs.length + 1}_${Date.now().toString(36)}`,
        name: "",
        unit: "mm",
        nominal: null,
        tolMinus: null,
        tolPlus: null,
        actual: "",
        adHoc: true,
      },
    ]);

  return (
    <ActionForm action={action} submitLabel={`Sign the ${STAGE_LABELS[stage]} sheet`} onSuccess={onSuccess}>
      <input type="hidden" name="pieceId" value={pieceId} />

      {!itemConfigured && (
        <p className="mb-3 rounded-[var(--radius-sm)] border border-[var(--warn-fg)] bg-[var(--warn-bg)] p-2.5 text-sm text-[var(--warn-fg)]">
          Nothing is configured for this item yet, so no dimensions were filled in for you. Add what
          you measured below, then ask an administrator to set the item up in Settings so the next
          piece comes ready.
        </p>
      )}

      {/* ── dimensions ── */}
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold">
          Dimensions — {STAGE_LABELS[stage]}
          <span className="ms-2 font-normal text-[var(--muted)]">
            {serial} · round {round + 1}
          </span>
        </h3>
        <button type="button" className="btn" onClick={addRow}>
          + Add a dimension
        </button>
      </div>

      <div className="scroll-x">
        <table className="tbl">
          <thead>
            <tr>
              <th>Dimension</th>
              <th>Nominal</th>
              <th>Tol −</th>
              <th>Tol +</th>
              <th>Actual</th>
              <th>Result</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const verdictOfRow = result({
                nominal: row.nominal,
                tolMinus: row.tolMinus,
                tolPlus: row.tolPlus,
                actual: row.actual.trim() === "" ? null : Number(row.actual),
              });
              return (
                <tr key={row.key}>
                  <td>
                    <input type="hidden" name="readingKey" value={row.key} />
                    <input type="hidden" name="readingAdHoc" value={row.adHoc ? "1" : "0"} />
                    <input type="hidden" name="readingUnit" value={row.unit ?? ""} />
                    {row.adHoc ? (
                      <input
                        className="input ltr"
                        name="readingName"
                        value={row.name}
                        placeholder="What you measured"
                        onChange={(e) => update(i, { name: e.target.value })}
                        required
                      />
                    ) : (
                      <>
                        <input type="hidden" name="readingName" value={row.name} />
                        <span className="font-semibold">{row.name}</span>
                        {row.unit && <span className="ms-1 text-xs text-[var(--muted)]">{row.unit}</span>}
                      </>
                    )}
                  </td>
                  {(["nominal", "tolMinus", "tolPlus"] as const).map((field) => (
                    <td key={field}>
                      <input
                        className="input num w-24"
                        type="number"
                        step="any"
                        name={`reading${field[0].toUpperCase()}${field.slice(1)}`}
                        value={row[field] ?? ""}
                        onChange={(e) =>
                          update(i, { [field]: e.target.value === "" ? null : Number(e.target.value) })
                        }
                      />
                    </td>
                  ))}
                  <td>
                    <input
                      className="input num w-28"
                      type="number"
                      step="any"
                      name="readingActual"
                      value={row.actual}
                      onChange={(e) => update(i, { actual: e.target.value })}
                    />
                  </td>
                  <td><StatusPill status={verdictOfRow} /></td>
                  <td>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => setRows((rs) => rs.filter((_, at) => at !== i))}
                      title="Remove this line from this sheet"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="py-4 text-center text-sm text-[var(--muted)]">
                  No dimensions. Add what you measured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── visual defects ── */}
      <h3 className="mt-4 mb-2 text-sm font-bold">Visual defects</h3>
      {ticks.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">
          No defect list is configured. An administrator can add one in Settings.
        </p>
      ) : (
        <div className="grid gap-2">
          {ticks.map((t, i) => (
            <div
              key={t.key}
              className="grid gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] p-2.5 sm:grid-cols-[1fr_auto]"
            >
              <input type="hidden" name="defectKey" value={t.key} />
              <input type="hidden" name="defectName" value={t.name} />
              <input type="hidden" name="defectSeen" value={t.seen ? "1" : "0"} />

              <label className="flex min-h-11 items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={t.seen}
                  onChange={(e) =>
                    setTicks((ts) => ts.map((x, at) => (at === i ? { ...x, seen: e.target.checked } : x)))
                  }
                />
                {t.name}
              </label>

              {t.seen && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <select
                    className="select"
                    name="defectDepartment"
                    value={t.chosenDepartment}
                    onChange={(e) =>
                      setTicks((ts) =>
                        ts.map((x, at) => (at === i ? { ...x, chosenDepartment: e.target.value } : x))
                      )
                    }
                  >
                    <option value="">— Whose defect? —</option>
                    {departments.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                  <input
                    className="input"
                    name="defectNote"
                    placeholder="Note (optional)"
                    value={t.note}
                    onChange={(e) =>
                      setTicks((ts) => ts.map((x, at) => (at === i ? { ...x, note: e.target.value } : x)))
                    }
                  />
                </div>
              )}
              {!t.seen && (
                <>
                  <input type="hidden" name="defectDepartment" value="" />
                  <input type="hidden" name="defectNote" value="" />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <PhotoField />

      {/* ── the verdict ── */}
      <div className="mt-4 rounded-[var(--radius-sm)] border border-[var(--border-strong)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-bold">What the measurements require</span>
          <StatusPill status={suggestion.verdict} />
        </div>
        <ul className="mt-1.5 grid gap-0.5 text-xs text-[var(--muted)]">
          {suggestion.reasons.map((r) => (
            <li key={r}>• {r}</li>
          ))}
        </ul>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="verdict">Verdict</label>
            <select
              id="verdict"
              className="select"
              name="verdict"
              value={verdict}
              onChange={(e) => setChosen(e.target.value as Verdict)}
            >
              {VERDICTS.filter((v) => v !== "ACCEPTED_BYPASS" || mayBypass).map((v) => (
                <option key={v} value={v}>
                  {VERDICT_LABELS[v]}
                  {v === suggestion.verdict ? " — what the evidence says" : ""}
                </option>
              ))}
            </select>
          </div>

          {verdict === "HOLD" && (
            <div>
              <label className="label" htmlFor="holdDepartment">Held against</label>
              <select
                id="holdDepartment"
                className="select"
                name="holdDepartment"
                value={holdDepartment}
                onChange={(e) => setDepartment(e.target.value)}
                required
              >
                <option value="">— Choose a department —</option>
                {departments.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {(verdict === "ACCEPTED_BYPASS" || isConcession) && (
          <div className="mt-3">
            <label className="label" htmlFor="bypassReason">
              Why this is being let through
            </label>
            <textarea
              id="bypassReason"
              className="textarea"
              name="bypassReason"
              rows={2}
              required={verdict === "ACCEPTED_BYPASS"}
              placeholder="The concession, and who authorised it"
            />
            <p className="mt-1 text-xs text-[var(--warn-fg)]">
              This piece does not meet what the drawing asks for. Accepting it is a concession,
              recorded against your name.
            </p>
          </div>
        )}

        {isConcession && !mayBypass && (
          <p className="mt-2 text-xs font-semibold text-[var(--bad-fg)]">
            Your account cannot grant a concession. Hold the piece, or ask a supervisor.
          </p>
        )}

        <p className="mt-3 text-xs text-[var(--muted)]">
          Signed by <strong>{me.displayName}</strong>. Once signed, this sheet cannot be changed —
          measure the piece again instead.
        </p>
      </div>
    </ActionForm>
  );
}
