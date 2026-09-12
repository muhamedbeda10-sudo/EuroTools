"use client";

import { useState } from "react";

import { ActionForm } from "./ActionForm";
import { Card, Empty, Field, StatusPill } from "./ui";
import { createAnalysis, saveAnalysisResults } from "@/lib/server/actions";
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
  analyses,
}: {
  lotId: string;
  analyses: AnalysisRow[];
}) {
  const def = stageDef("RAW_ANALYSIS");
  const [rows, setRows] = useState(DEFAULT_PROPERTIES);

  return (
    <Card
      className="mt-4"
      title={`${def.order}. ${def.ar}`}
      subtitle={`${def.en} — عينات عشوائية تُقارن نتائجها بالمواصفة`}
    >
      {analyses.length === 0 ? (
        <Empty>لم يُفتح أي تحليل على هذه التشغيلة بعد.</Empty>
      ) : (
        <div className="grid gap-4">
          {analyses.map((a) => (
            <AnalysisCard key={a.id} analysis={a} lotId={lotId} />
          ))}
        </div>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-bold text-[var(--brand)]">
          فتح تحليل عينة جديد
        </summary>

        <div className="mt-3">
          <ActionForm action={createAnalysis} submitLabel="فتح التحليل">
            <input type="hidden" name="lotId" value={lotId} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="مرجع العينة">
                <input className="input ltr" name="sampleRef" required placeholder="S-001" />
              </Field>
              <Field label="طريقة الاختبار">
                <select className="select" name="method" defaultValue="Spectro">
                  <option value="Spectro">تحليل طيفي (Spectro)</option>
                  <option value="Tensile">اختبار شد (Tensile)</option>
                  <option value="Hardness">صلادة (Hardness)</option>
                  <option value="Metallography">فحص مجهري (Metallography)</option>
                </select>
              </Field>
              <Field label="أجراه">
                <input className="input" name="performedBy" />
              </Field>
            </div>

            <h4 className="mt-4 mb-2 text-sm font-bold">الخواص المطلوب قياسها</h4>
            <div className="scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>الخاصية</th>
                    <th>الحد الأدنى</th>
                    <th>الحد الأقصى</th>
                    <th>الوحدة</th>
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
                          حذف
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
              + إضافة خاصية
            </button>
          </ActionForm>
        </div>
      </details>
    </Card>
  );
}

function AnalysisCard({ analysis, lotId }: { analysis: AnalysisRow; lotId: string }) {
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

      <ActionForm action={saveAnalysisResults} submitLabel="حفظ النتائج">
        <input type="hidden" name="lotId" value={lotId} />
        <input type="hidden" name="analysisId" value={analysis.id} />

        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>الخاصية</th>
                <th>المطلوب</th>
                <th>النتيجة الفعلية</th>
                <th>الحكم</th>
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
          <Field label="أجراه">
            <input className="input" name="performedBy" defaultValue={analysis.performedBy ?? ""} />
          </Field>
          <Field label="الخلاصة">
            <input className="input" name="conclusion" defaultValue={analysis.conclusion ?? ""} />
          </Field>
          <Field label="الإجراء المتخذ عند عدم المطابقة">
            <input className="input" name="actionTaken" defaultValue={analysis.actionTaken ?? ""} />
          </Field>
        </div>
      </ActionForm>
    </div>
  );
}
