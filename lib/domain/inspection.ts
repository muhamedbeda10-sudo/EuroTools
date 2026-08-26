/** Pure inspection rules. No I/O — every function here is unit-tested and is
 *  the only place a pass/fail decision is made. */

import {
  PART_STAGES,
  STAGE_DEFS,
  stageDef,
  type Stage,
  type Status,
} from "./stages";

export type MeasurementResult = "PASS" | "FAIL" | "PENDING";

export interface MeasurementSpec {
  /** "DIMENSION" (the default) or "GDT". Typed loosely because the database
   *  column is a plain string — anything that is not "GDT" reads as a
   *  dimension. */
  kind?: string | null;
  nominal?: number | null;
  tolMinus?: number | null;
  tolPlus?: number | null;
  /** GD&T: the callout value, e.g. 0.02 for a 0.02 runout. */
  gdtLimit?: number | null;
  actual?: number | null;
  critical?: boolean;
}

/** Tolerance band for a dimension: `nominal - tolMinus … nominal + tolPlus`.
 *  Both tolerances are stored as positive magnitudes. */
export function toleranceBand(
  spec: Pick<MeasurementSpec, "nominal" | "tolMinus" | "tolPlus">
): { min: number; max: number } | null {
  if (spec.nominal == null) return null;
  const minus = Math.abs(spec.tolMinus ?? 0);
  const plus = Math.abs(spec.tolPlus ?? 0);
  return { min: spec.nominal - minus, max: spec.nominal + plus };
}

/** Verdict for one measured feature.
 *  - a GD&T callout passes while `0 <= actual <= gdtLimit`
 *  - a dimension passes inside its tolerance band
 *  - no reading, or no spec to compare against, stays PENDING */
export function measurementResult(spec: MeasurementSpec): MeasurementResult {
  const actual = spec.actual;
  if (actual == null || Number.isNaN(actual)) return "PENDING";

  if (spec.kind === "GDT") {
    if (spec.gdtLimit == null) return "PENDING";
    return actual >= 0 && actual <= spec.gdtLimit ? "PASS" : "FAIL";
  }

  const band = toleranceBand(spec);
  if (!band) return "PENDING";
  return actual >= band.min && actual <= band.max ? "PASS" : "FAIL";
}

/** How far outside the band a failing reading sits (0 when it passes).
 *  Used to sort a rejection report worst-first. */
export function deviation(spec: MeasurementSpec): number | null {
  if (spec.actual == null || Number.isNaN(spec.actual)) return null;
  if (spec.kind === "GDT") {
    if (spec.gdtLimit == null) return null;
    if (spec.actual < 0) return Math.abs(spec.actual);
    return Math.max(0, spec.actual - spec.gdtLimit);
  }
  const band = toleranceBand(spec);
  if (!band) return null;
  if (spec.actual < band.min) return band.min - spec.actual;
  if (spec.actual > band.max) return spec.actual - band.max;
  return 0;
}

export type HardnessVerdict = "IN_RANGE" | "BELOW" | "ABOVE" | "UNKNOWN";

/** Compare a hardness reading against the required window. A one-sided window
 *  is honoured — a spec with only a minimum is common for case hardening. */
export function hardnessVerdict(
  value: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined
): HardnessVerdict {
  if (value == null || Number.isNaN(value)) return "UNKNOWN";
  if (min == null && max == null) return "UNKNOWN";
  if (min != null && value < min) return "BELOW";
  if (max != null && value > max) return "ABOVE";
  return "IN_RANGE";
}

/** Surface finish passes while the measured Ra is at or under the required Ra
 *  (smoother is always acceptable). */
export function surfaceFinishOk(
  measuredRa: number | null | undefined,
  requiredRa: number | null | undefined
): boolean | null {
  if (measuredRa == null || requiredRa == null) return null;
  return measuredRa <= requiredRa;
}

export interface RollupInput {
  stage: Stage;
  /** Checklist answers, keyed the same way the stage template is. */
  checks: Record<string, boolean | null | undefined>;
  measurements?: MeasurementSpec[];
  hardness?: { value?: number | null; min?: number | null; max?: number | null };
}

export interface Rollup {
  /** The verdict the rules arrive at on their own. */
  suggested: Status;
  /** Checklist keys still unanswered. */
  unanswered: string[];
  /** Checklist keys answered "not ok". */
  failedChecks: string[];
  /** Indices into `measurements` that failed. */
  failedMeasurements: number[];
  /** True when any failing measurement is flagged critical. */
  criticalFailure: boolean;
  hardness: HardnessVerdict;
  reasons: string[];
}

/** Suggest a verdict from the filled-in checklist.
 *
 *  The inspector always has the final word — this only proposes, and the UI
 *  shows the reasons. The rule is deliberately conservative:
 *
 *  - anything unanswered            → PENDING
 *  - a critical measurement failure → REJECTED
 *  - a failed check or measurement  → the stage's middle outcome
 *                                     (REWORK, or FURTHER_INVESTIGATION after
 *                                      heat treatment, where a rework is not
 *                                      the shop's call to make)
 *  - hardness out of range          → REJECTED below range, FURTHER_INVESTIGATION above
 *  - all clear                      → the stage's accepting outcome
 */
export function rollup(input: RollupInput): Rollup {
  const def = stageDef(input.stage);
  const measurements = input.measurements ?? [];

  const unanswered = def.items
    .filter((i) => input.checks[i.key] == null)
    .map((i) => i.key);
  const failedChecks = def.items
    .filter((i) => input.checks[i.key] === false)
    .map((i) => i.key);

  const failedMeasurements: number[] = [];
  measurements.forEach((m, i) => {
    if (measurementResult(m) === "FAIL") failedMeasurements.push(i);
  });
  const criticalFailure = failedMeasurements.some((i) => measurements[i].critical === true);

  const hardness = input.hardness
    ? hardnessVerdict(input.hardness.value, input.hardness.min, input.hardness.max)
    : "UNKNOWN";

  const reasons: string[] = [];
  const accepting: Status = def.outcomes.includes("RELEASED") ? "RELEASED" : "ACCEPTED";
  const middle: Status = def.outcomes.includes("REWORK")
    ? "REWORK"
    : def.outcomes.includes("FURTHER_INVESTIGATION")
      ? "FURTHER_INVESTIGATION"
      : "REJECTED";

  let suggested: Status = accepting;

  if (criticalFailure) {
    reasons.push("critical-measurement-failed");
    suggested = "REJECTED";
  } else if (input.stage === "HEAT_TREATMENT" && hardness === "BELOW") {
    reasons.push("hardness-below-range");
    suggested = "REJECTED";
  } else if (input.stage === "HEAT_TREATMENT" && hardness === "ABOVE") {
    reasons.push("hardness-above-range");
    suggested = "FURTHER_INVESTIGATION";
  } else if (failedChecks.length > 0 || failedMeasurements.length > 0) {
    if (failedChecks.length > 0) reasons.push("checklist-item-failed");
    if (failedMeasurements.length > 0) reasons.push("measurement-out-of-tolerance");
    suggested = middle;
  }

  // An incomplete sheet can never be signed off, but a failure already found
  // stands on its own — you do not need the rest of the sheet to reject.
  if (unanswered.length > 0 && suggested === accepting) {
    reasons.push("checklist-incomplete");
    suggested = "PENDING";
  }

  if (reasons.length === 0) reasons.push("all-clear");

  return {
    suggested,
    unanswered,
    failedChecks,
    failedMeasurements,
    criticalFailure,
    hardness,
    reasons,
  };
}

// ───────────────────────── traveller flow ─────────────────────────

export type PartStatus = "IN_PROCESS" | "REWORK" | "RELEASED" | "REJECTED" | "HOLD";

export interface PartTransition {
  stage: Stage | "DONE";
  status: PartStatus;
}

/** Where a part goes after a verdict at its current stage.
 *
 *  ACCEPTED / RELEASED  → forward to the next stage (or DONE after final)
 *  REWORK               → stays put, flagged for re-inspection
 *  FURTHER_INVESTIGATION→ stays put, on hold pending engineering
 *  REJECTED             → scrapped, the traveller ends
 */
export function nextPartState(current: Stage, verdict: Status): PartTransition {
  const def = stageDef(current);
  if (def.subject !== "PART") throw new Error(`${current} is not a part stage`);
  if (!def.outcomes.includes(verdict))
    throw new Error(`${verdict} is not a valid outcome for ${current}`);

  switch (verdict) {
    case "ACCEPTED":
    case "RELEASED": {
      const next = def.next ?? "DONE";
      return { stage: next, status: next === "DONE" ? "RELEASED" : "IN_PROCESS" };
    }
    case "REWORK":
      return { stage: current, status: "REWORK" };
    case "FURTHER_INVESTIGATION":
      return { stage: current, status: "HOLD" };
    case "REJECTED":
      return { stage: current, status: "REJECTED" };
    default:
      return { stage: current, status: "IN_PROCESS" };
  }
}

/** A part may only be inspected at the stage it is standing in, and only while
 *  the traveller is still open. */
export function canInspect(
  part: { currentStage: string; status: string },
  stage: Stage
): { ok: boolean; reason?: string } {
  if (part.status === "REJECTED") return { ok: false, reason: "الجزء مرفوض ولا يمكن استكمال فحصه." };
  if (part.status === "RELEASED") return { ok: false, reason: "الجزء تم الإفراج عنه بالفعل." };
  if (part.currentStage === "DONE") return { ok: false, reason: "انتهت مراحل هذا الجزء." };
  if (part.currentStage !== stage)
    return {
      ok: false,
      reason: `الجزء في مرحلة ${stageDef(part.currentStage).ar} ولا يمكن فحصه في ${stageDef(stage).ar}.`,
    };
  return { ok: true };
}

/** Parts may only be raised against a lot that cleared receiving **and** whose
 *  analysis (when one was required) came back accepted. */
export function canRaiseParts(lot: {
  status: string;
  analyses?: { status: string }[];
}): { ok: boolean; reason?: string } {
  if (lot.status !== "ACCEPTED")
    return { ok: false, reason: "لم يتم قبول الخامة في الاستلام بعد." };
  const analyses = lot.analyses ?? [];
  if (analyses.some((a) => a.status === "REJECTED"))
    return { ok: false, reason: "يوجد تحليل مرفوض على هذه الخامة." };
  if (analyses.length > 0 && analyses.every((a) => a.status === "PENDING"))
    return { ok: false, reason: "تحليل الخامة ما زال قيد التنفيذ." };
  return { ok: true };
}

/** 0…1 progress of a traveller through the four part stages. */
export function travellerProgress(part: { currentStage: string; status: string }): number {
  if (part.status === "RELEASED" || part.currentStage === "DONE") return 1;
  const i = PART_STAGES.indexOf(part.currentStage as Stage);
  if (i < 0) return 0;
  return i / PART_STAGES.length;
}

/** Certificates the lot is still missing, given the material's requirement
 *  list. Comparison is case- and whitespace-insensitive. */
export function missingCertificates(
  requiredCerts: string | null | undefined,
  present: { type: string; received: boolean }[]
): string[] {
  if (!requiredCerts) return [];
  const have = new Set(
    present.filter((c) => c.received).map((c) => c.type.trim().toLowerCase())
  );
  return requiredCerts
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((req) => !have.has(req.toLowerCase()));
}

/** Compare one analysis reading against its required window. */
export function analysisResultPass(r: {
  requiredMin?: number | null;
  requiredMax?: number | null;
  requiredText?: string | null;
  actual?: number | null;
  actualText?: string | null;
}): boolean | null {
  if (r.requiredText != null && r.requiredText !== "") {
    if (r.actualText == null || r.actualText === "") return null;
    return r.actualText.trim().toLowerCase() === r.requiredText.trim().toLowerCase();
  }
  if (r.actual == null || Number.isNaN(r.actual)) return null;
  if (r.requiredMin == null && r.requiredMax == null) return null;
  if (r.requiredMin != null && r.actual < r.requiredMin) return false;
  if (r.requiredMax != null && r.actual > r.requiredMax) return false;
  return true;
}

/** Lot-level analysis verdict: any failed property fails the sample; an
 *  unread property keeps it pending. */
export function analysisStatus(
  results: Parameters<typeof analysisResultPass>[0][]
): Status {
  if (results.length === 0) return "PENDING";
  const verdicts = results.map(analysisResultPass);
  if (verdicts.some((v) => v === false)) return "REJECTED";
  if (verdicts.some((v) => v == null)) return "PENDING";
  return "ACCEPTED";
}

export const ALL_STAGES_IN_ORDER = STAGE_DEFS.map((d) => d.stage);
