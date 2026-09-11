"use client";

import { useMemo, useState } from "react";

import { ActionForm } from "./ActionForm";
import { StatusPill } from "./ui";
import {
  hardnessVerdict,
  measurementResult,
  rollup,
  type MeasurementSpec,
} from "@/lib/domain/inspection";
import {
  GROUP_LABELS,
  STATUS_LABELS,
  stageDef,
  type Stage,
  type Status,
} from "@/lib/domain/stages";
import { ROLE_LABELS, can, verdictPermission, type Role } from "@/lib/domain/roles";
import { fmtNum, fmtTolerance } from "@/lib/format";
import type { ActionResult } from "@/lib/server/actions";

/** The account that will sign this sheet. Resolved on the server and passed
 *  down, never typed. */
export interface Signatory {
  displayName: string;
  role: Role;
}

export interface FeatureRow {
  id: number;
  name: string;
  kind: string;
  nominal: number | null;
  tolMinus: number;
  tolPlus: number;
  gdtLimit: number | null;
  gdtSymbol: string | null;
  unit: string;
  critical: boolean;
}

const REASON_LABELS: Record<string, string> = {
  "all-clear": "كل البنود مطابقة",
  "checklist-incomplete": "الكشف غير مكتمل — توجد بنود بدون إجابة",
  "checklist-item-failed": "بند غير مطابق في الكشف",
  "measurement-out-of-tolerance": "قياس خارج السماحية",
  "critical-measurement-failed": "خاصية حرجة (Critical) خارج السماحية",
  "hardness-below-range": "الصلادة أقل من المدى المطلوب",
  "hardness-above-range": "الصلادة أعلى من المدى المطلوب",
};

/** The stage checklist: tri-state answers, the stage's measurements, and a
 *  live verdict computed by the same pure rules the server re-applies on
 *  submit — the inspector sees the outcome before signing. */
export function ChecklistForm({
  stage,
  action,
  hiddenFields,
  signatory,
  features = [],
  hardnessRange,
  requiredRa,
  submitLabel = "تسجيل الفحص",
}: {
  stage: Stage;
  action: (formData: FormData) => Promise<ActionResult>;
  hiddenFields: Record<string, string | number>;
  signatory: Signatory;
  features?: FeatureRow[];
  hardnessRange?: { min: number | null; max: number | null; unit: string };
  requiredRa?: number | null;
  submitLabel?: string;
}) {
  const def = stageDef(stage);

  const [checks, setChecks] = useState<Record<string, boolean | null>>(() =>
    Object.fromEntries(def.items.map((i) => [i.key, null]))
  );
  const [actuals, setActuals] = useState<Record<number, string>>({});
  const [hardness, setHardness] = useState("");
  const [ra, setRa] = useState("");
  const [override, setOverride] = useState("");

  const specs: MeasurementSpec[] = useMemo(
    () =>
      features.map((f) => ({
        kind: f.kind === "GDT" ? "GDT" : "DIMENSION",
        nominal: f.nominal,
        tolMinus: f.tolMinus,
        tolPlus: f.tolPlus,
        gdtLimit: f.gdtLimit,
        actual: actuals[f.id] === "" || actuals[f.id] == null ? null : Number(actuals[f.id]),
        critical: f.critical,
      })),
    [features, actuals]
  );

  const verdict = useMemo(
    () =>
      rollup({
        stage,
        checks,
        measurements: specs,
        hardness: hardnessRange
          ? {
              value: hardness === "" ? null : Number(hardness),
              min: hardnessRange.min,
              max: hardnessRange.max,
            }
          : undefined,
      }),
    [stage, checks, specs, hardness, hardnessRange]
  );

  // Which verdicts this account may actually file, decided by the same pure
  // rules the action re-applies on submit. Showing a choice that would be
  // refused on the server wastes a filled-in sheet.
  const selectable = useMemo(
    () =>
      def.outcomes.filter((o) =>
        can(signatory.role, verdictPermission(o, verdict.suggested))
      ),
    [def.outcomes, signatory.role, verdict.suggested]
  );

  // Anything beyond agreeing with the suggestion is an override.
  const canOverride = selectable.some((o) => o !== verdict.suggested);

  // A selection can stop being available when the answers change the
  // suggestion underneath it; fall back rather than post something stale.
  const effectiveOverride = selectable.includes(override as Status) ? override : "";

  const hv = hardnessRange
    ? hardnessVerdict(
        hardness === "" ? null : Number(hardness),
        hardnessRange.min,
        hardnessRange.max
      )
    : "UNKNOWN";

  // Section headings only appear on the stages the checklist actually splits.
  const groups = useMemo(() => {
    const seen: string[] = [];
    for (const item of def.items) {
      const g = item.group ?? "";
      if (!seen.includes(g)) seen.push(g);
    }
    return seen;
  }, [def]);

  function setAll(value: boolean) {
    setChecks(Object.fromEntries(def.items.map((i) => [i.key, value])));
  }

  return (
    <ActionForm action={action} submitLabel={submitLabel}>
      {Object.entries(hiddenFields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {def.items.map((i) => (
        <input
          key={i.key}
          type="hidden"
          name={`check_${i.key}`}
          value={checks[i.key] === true ? "yes" : checks[i.key] === false ? "no" : ""}
        />
      ))}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--muted)]">
            {def.items.length} بند
          </span>
          <button type="button" className="btn" onClick={() => setAll(true)}>
            تحديد الكل مطابق
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setChecks(Object.fromEntries(def.items.map((i) => [i.key, null])))}
          >
            مسح
          </button>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="text-[var(--muted)]">النتيجة المقترحة:</span>
          <StatusPill status={verdict.suggested} />
        </div>
      </div>

      {/* ── checklist ── */}
      {groups.map((g) => (
        <div key={g} className="mb-4">
          {g && (
            <h3 className="mb-2 text-sm font-bold text-[var(--brand-dark)]">
              {GROUP_LABELS[g]?.ar ?? g}
            </h3>
          )}
          <ul className="grid gap-1.5">
            {def.items
              .filter((i) => (i.group ?? "") === g)
              .map((item) => (
                <li
                  key={item.key}
                  className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] p-2.5"
                >
                  <div className="min-w-[14rem] flex-1">
                    <div className="text-sm font-semibold">{item.ar}</div>
                    <div className="ltr text-xs text-[var(--muted)]">{item.en}</div>
                  </div>

                  <div className="flex shrink-0 gap-1">
                    <TriButton
                      active={checks[item.key] === true}
                      tone="ok"
                      label="مطابق"
                      onClick={() => setChecks((c) => ({ ...c, [item.key]: true }))}
                    />
                    <TriButton
                      active={checks[item.key] === false}
                      tone="bad"
                      label="غير مطابق"
                      onClick={() => setChecks((c) => ({ ...c, [item.key]: false }))}
                    />
                  </div>

                  <input
                    className="input w-full sm:w-56"
                    name={`note_${item.key}`}
                    placeholder="ملاحظة (اختياري)"
                  />
                </li>
              ))}
          </ul>
        </div>
      ))}

      {/* ── hardness ── */}
      {hardnessRange && (
        <div className="mb-4 rounded-[var(--radius-sm)] border border-[var(--border)] p-3">
          <h3 className="mb-2 text-sm font-bold text-[var(--brand-dark)]">
            قيمة الصلادة الفعلية
          </h3>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label">
                Hardness ({hardnessRange.unit})
              </label>
              <input
                className="input num w-40"
                name="hardnessValue"
                type="number"
                step="0.1"
                value={hardness}
                onChange={(e) => setHardness(e.target.value)}
              />
            </div>
            <div className="text-sm">
              <div className="text-xs text-[var(--muted)]">المدى المطلوب</div>
              <div className="num font-bold">
                {hardnessRange.min == null && hardnessRange.max == null
                  ? "غير محدد"
                  : `${fmtNum(hardnessRange.min)} – ${fmtNum(hardnessRange.max)} ${hardnessRange.unit}`}
              </div>
            </div>
            <div>
              {hv === "IN_RANGE" && <span className="pill pill-ok">داخل المدى</span>}
              {hv === "BELOW" && <span className="pill pill-bad">أقل من المدى</span>}
              {hv === "ABOVE" && <span className="pill pill-warn">أعلى من المدى</span>}
              {hv === "UNKNOWN" && <span className="pill pill-neutral">لم تُقَس</span>}
            </div>
          </div>
        </div>
      )}

      {/* ── measurements ── */}
      {features.length > 0 && (
        <div className="mb-4">
          <h3 className="mb-2 text-sm font-bold text-[var(--brand-dark)]">
            القياسات المطلوبة في هذه المرحلة
          </h3>
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>الخاصية</th>
                  <th>النوع</th>
                  <th>المطلوب</th>
                  <th>المقاس</th>
                  <th>النتيجة</th>
                </tr>
              </thead>
              <tbody>
                {features.map((f, idx) => {
                  const res = measurementResult(specs[idx]);
                  return (
                    <tr key={f.id}>
                      <td>
                        <span className="font-semibold">{f.name}</span>
                        {f.critical && (
                          <span className="pill pill-bad ms-2">Critical</span>
                        )}
                      </td>
                      <td className="text-xs text-[var(--muted)]">
                        {f.kind === "GDT" ? `GD&T ${f.gdtSymbol ?? ""}` : "بُعد"}
                      </td>
                      <td className="num">
                        {f.kind === "GDT"
                          ? `≤ ${fmtNum(f.gdtLimit)} ${f.unit}`
                          : `${fmtTolerance(f.nominal, f.tolMinus, f.tolPlus)} ${f.unit}`}
                      </td>
                      <td>
                        <input
                          className="input num w-32"
                          name={`actual_${f.id}`}
                          type="number"
                          step="0.0001"
                          value={actuals[f.id] ?? ""}
                          onChange={(e) =>
                            setActuals((a) => ({ ...a, [f.id]: e.target.value }))
                          }
                        />
                      </td>
                      <td>
                        <StatusPill status={res} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── final-stage extras ── */}
      {stage === "FINAL" && (
        <div className="mb-4 grid gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] p-3 sm:grid-cols-2">
          <div>
            <label className="label">
              Surface Finish المقاس (Ra µm)
              {requiredRa != null && (
                <span className="num ms-1 font-normal">— المطلوب ≤ {fmtNum(requiredRa)}</span>
              )}
            </label>
            <input
              className="input num"
              name="surfaceFinishRa"
              type="number"
              step="0.01"
              value={ra}
              onChange={(e) => setRa(e.target.value)}
            />
            {ra !== "" && requiredRa != null && (
              <p className="mt-1">
                <StatusPill status={Number(ra) <= requiredRa ? "PASS" : "FAIL"} />
              </p>
            )}
          </div>
          <div>
            <label className="label">مرجع تقرير الـ CMM</label>
            <input className="input ltr" name="cmmReportRef" placeholder="CMM-2026-0142" />
            <div className="mt-2 flex gap-4 text-sm">
              <label className="flex items-center gap-1.5">
                <input type="checkbox" name="cmmRequired" /> مطلوب CMM
              </label>
              <label className="flex items-center gap-1.5">
                <input type="checkbox" name="cmmReviewed" /> تمت مراجعة التقرير
              </label>
            </div>
          </div>
        </div>
      )}

      {/* ── verdict ── */}
      <div className="rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface-2)] p-3">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold">النتيجة النهائية</span>
          <StatusPill status={effectiveOverride || verdict.suggested} />
          {effectiveOverride && (
            <span className="pill pill-warn">تم تجاوز الاقتراح يدويًا</span>
          )}
        </div>

        <ul className="mb-3 grid gap-0.5 text-xs text-[var(--muted)]">
          {verdict.reasons.map((r) => (
            <li key={r}>• {REASON_LABELS[r] ?? r}</li>
          ))}
          {verdict.unanswered.length > 0 && (
            <li>• بنود بدون إجابة: {verdict.unanswered.length}</li>
          )}
        </ul>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">الحالة (اتركها فارغة لاعتماد الاقتراح)</label>
            {canOverride ? (
              <select
                className="select"
                name="status"
                value={effectiveOverride}
                onChange={(e) => setOverride(e.target.value)}
              >
                <option value="">
                  — اعتماد الاقتراح ({STATUS_LABELS[verdict.suggested].ar}) —
                </option>
                {selectable.map((o: Status) => (
                  <option key={o} value={o}>
                    {STATUS_LABELS[o].ar}
                  </option>
                ))}
              </select>
            ) : (
              <p className="rounded-lg bg-[var(--surface)] px-3 py-2 text-sm text-[var(--muted)]">
                يُسجَّل الفحص بالنتيجة المحسوبة: {STATUS_LABELS[verdict.suggested].ar}. تغييرها
                يحتاج صلاحية أعلى.
              </p>
            )}
          </div>
          <div>
            <label className="label">الفاحص الموقِّع</label>
            <p className="rounded-lg bg-[var(--surface)] px-3 py-2 text-sm font-semibold">
              {signatory.displayName}
              <span className="ms-2 font-normal text-[var(--muted)]">
                ({ROLE_LABELS[signatory.role].ar})
              </span>
            </p>
          </div>
        </div>

        <div className="mt-3">
          <label className="label">ملاحظات عامة</label>
          <textarea className="textarea" name="notes" rows={2} />
        </div>
      </div>
    </ActionForm>
  );
}

function TriButton({
  active,
  tone,
  label,
  onClick,
}: {
  active: boolean;
  tone: "ok" | "bad";
  label: string;
  onClick: () => void;
}) {
  const activeClass =
    tone === "ok"
      ? "bg-[var(--ok-bg)] text-[var(--ok-fg)] border-[var(--ok-fg)]"
      : "bg-[var(--bad-bg)] text-[var(--bad-fg)] border-[var(--bad-fg)]";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-bold transition ${
        active ? activeClass : "border-[var(--border-strong)] text-[var(--muted)]"
      }`}
    >
      {label}
    </button>
  );
}
