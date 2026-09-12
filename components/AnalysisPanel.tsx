"use client";

import { useState } from "react";

import { ActionForm } from "./ActionForm";
import { Card, Empty, Field, StatusPill } from "./ui";
import { createAnalysis, saveAnalysisResults } from "@/lib/client/actions";
import type { SessionUser } from "@/lib/client/session";
import { analysisResultPass } from "@/lib/domain/inspection";
import { fmtDateTime, fmtNum } from "@/lib/format";
import { stageDef } from "@/lib/domain/stages";

interface ResultRow {
  id: string;
  property: string;
  requiredMin: number | null;
  requiredMax: number | null;
  requiredText: string | null;
  actual: number | null;
  actualText: string | null;
  unit: string | null;
}

interface AnalysisRow {
  id: string;
  sampleRef: string;
  method: string | null;
  performedAt: Date;
  performedBy: string | null;
  status: string;
  conclusion: string | null;
  actionTaken: string | null;
  results: ResultRow[];
}

/** A starter chemistry list — the lab edits the rows before opening the
 *  sample, so a different alloy needs no code change. */
const DEFAULT_PROPERTIES = [
  { property: "C %", requiredMin: "", requiredMax: "", unit: "%" },
  { property: "Si %", requiredMin: "", requiredMax: "", unit: "%" },
  { property: "Mn %", requiredMin: "", requiredMax: "", unit: "%" },
  { property: "Cr %", requiredMin: "", requiredMax: "", unit: "%" },
  { property: "P %", requiredMin: "", requiredMax: "", unit: "%" },
  { property: "S %", requiredMin: "", requiredMax: "", unit: "%" },
];

export function AnalysisPanel({
  lotId,
  user,
  onSaved,
  analyses,
}: {
  lotId: string;
  user: SessionUser;
  onSaved?: () => void;
  analyses: AnalysisRow[];
}) {
  const def = stageDef("RAW_ANALYSIS");
  const [rows, setRows] = useState(DEFAULT_PROPERTIES);

  return (
    <Card
      className="mt-4"
      title={`${def.order}. ${def.en}`}
      subtitle={`${def.en} — random samples, compared against the specification`}
    >
      {analyses.length === 0 ? (
        <Empty>No analysis has been opened on this lot yet.</Empty>
      ) : (
        <div className="grid gap-4">
          {analyses.map((a) => (
            <AnalysisCard key={a.id} analysis={a} lotId={lotId} user={user} onSaved={onSaved} />
          ))}
        </div>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-bold text-[var(--brand)]">
          Open a new sample analysis
        </summary>

        <div className="mt-3">
          <ActionForm action={createAnalysis(user)} onSuccess={onSaved} submitLabel="Open analysis">
            <input type="hidden" name="lotId" value={lotId} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Sample reference">
                <input className="input ltr" name="sampleRef" required placeholder="S-001" />
              </Field>
              <Field label="Test method">
                <select className="select" name="method" defaultValue="Spectro">
                  <option value="Spectro">Spectrographic</option>
                  <option value="Tensile">Tensile</option>
                  <option value="Hardness">Hardness</option>
                  <option value="Metallography">Metallography</option>
                </select>
              </Field>
              <Field label="Performed by">
                <input className="input" name="performedBy" />
              </Field>
            </div>

            <h4 className="mt-4 mb-2 text-sm font-bold">Properties to measure</h4>
            <div className="scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>Minimum</th>
                    <th>Maximum</th>
                    <th>Unit</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          className="input ltr w-32"
                          name="property"
                          value={r.property}
                          onChange={(e) =>
                            setRows((rs) =>
                              rs.map((x, j) => (j === i ? { ...x, property: e.target.value } : x))
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="input num w-24"
                          name="requiredMin"
                          type="number"
                          step="0.0001"
                          value={r.requiredMin}
                          onChange={(e) =>
                            setRows((rs) =>
                              rs.map((x, j) => (j === i ? { ...x, requiredMin: e.target.value } : x))
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="input num w-24"
                          name="requiredMax"
                          type="number"
                          step="0.0001"
                          value={r.requiredMax}
                          onChange={(e) =>
                            setRows((rs) =>
                              rs.map((x, j) => (j === i ? { ...x, requiredMax: e.target.value } : x))
                            )
                          }
                        />
                      </td>
                      <td>
                        <input
                          className="input ltr w-20"
                          name="unit"
                          value={r.unit}
                          onChange={(e) =>
                            setRows((rs) =>
                              rs.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x))
                            )
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button
              type="button"
              className="btn mt-2"
              onClick={() =>
                setRows((rs) => [...rs, { property: "", requiredMin: "", requiredMax: "", unit: "%" }])
              }
            >
              + Add property
            </button>
          </ActionForm>
        </div>
      </details>
    </Card>
  );
}

function AnalysisCard({
  analysis,
  lotId,
  user,
  onSaved,
}: {
  analysis: AnalysisRow;
  lotId: string;
  user: SessionUser;
  onSaved?: () => void;
}) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--border-strong)] p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="ltr font-bold">{analysis.sampleRef}</span>
          <span className="ms-2 text-xs text-[var(--muted)]">
            {analysis.method ?? "—"} · {fmtDateTime(analysis.performedAt)}
          </span>
        </div>
        <StatusPill status={analysis.status} />
      </div>

      <ActionForm
        action={saveAnalysisResults(user)}
        onSuccess={onSaved}
        submitLabel="Save results"
      >
        <input type="hidden" name="lotId" value={lotId} />
        <input type="hidden" name="analysisId" value={analysis.id} />

        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>Property</th>
                <th>Required</th>
                <th>Measured</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {analysis.results.map((r) => {
                const pass = analysisResultPass(r);
                const required =
                  r.requiredText != null && r.requiredText !== ""
                    ? r.requiredText
                    : r.requiredMin != null && r.requiredMax != null
                      ? `${fmtNum(r.requiredMin)} – ${fmtNum(r.requiredMax)}`
                      : r.requiredMin != null
                        ? `≥ ${fmtNum(r.requiredMin)}`
                        : r.requiredMax != null
                          ? `≤ ${fmtNum(r.requiredMax)}`
                          : "—";
                return (
                  <tr key={r.id}>
                    <td className="ltr font-semibold">{r.property}</td>
                    <td className="num">
                      {required} {r.unit ?? ""}
                    </td>
                    <td>
                      {r.requiredText != null && r.requiredText !== "" ? (
                        <input
                          className="input w-32"
                          name={`actualText_${r.id}`}
                          defaultValue={r.actualText ?? ""}
                        />
                      ) : (
                        <input
                          className="input num w-28"
                          name={`actual_${r.id}`}
                          type="number"
                          step="0.0001"
                          defaultValue={r.actual ?? ""}
                        />
                      )}
                    </td>
                    <td>
                      <StatusPill
                        status={pass == null ? "PENDING" : pass ? "PASS" : "FAIL"}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Performed by">
            <input className="input" name="performedBy" defaultValue={analysis.performedBy ?? ""} />
          </Field>
          <Field label="Conclusion">
            <input className="input" name="conclusion" defaultValue={analysis.conclusion ?? ""} />
          </Field>
          <Field label="Action taken on non-conformance">
            <input className="input" name="actionTaken" defaultValue={analysis.actionTaken ?? ""} />
          </Field>
        </div>
      </ActionForm>
    </div>
  );
}
