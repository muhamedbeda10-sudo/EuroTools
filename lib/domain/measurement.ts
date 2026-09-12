/** What a reading means against its drawing, and what the readings together
 *  mean for the piece. Pure, and the only place a pass or a fail is decided.
 */

export type Result = "PASS" | "FAIL" | "NOT_MEASURED";

export interface Spec {
  nominal?: number | null;
  /** Stored as positive magnitudes: the band is nominal − minus … nominal + plus. */
  tolMinus?: number | null;
  tolPlus?: number | null;
  actual?: number | null;
}

export function toleranceBand(spec: Spec): { min: number; max: number } | null {
  if (spec.nominal == null || Number.isNaN(spec.nominal)) return null;
  return {
    min: spec.nominal - Math.abs(spec.tolMinus ?? 0),
    max: spec.nominal + Math.abs(spec.tolPlus ?? 0),
  };
}

/** A reading exactly on a limit passes. That is the convention the shop floor
 *  works to, and it is stated here rather than left to a `<` somebody might
 *  later "tidy" into a `<=` or the other way about. */
export function result(spec: Spec): Result {
  if (spec.actual == null || Number.isNaN(spec.actual)) return "NOT_MEASURED";
  const band = toleranceBand(spec);
  if (!band) return "NOT_MEASURED";
  return spec.actual >= band.min && spec.actual <= band.max ? "PASS" : "FAIL";
}

/** How far outside the band a reading sits; zero when it is inside. Sorts a
 *  report worst-first, and tells a machinist how much to take off. */
export function deviation(spec: Spec): number | null {
  if (spec.actual == null || Number.isNaN(spec.actual)) return null;
  const band = toleranceBand(spec);
  if (!band) return null;
  if (spec.actual < band.min) return spec.actual - band.min;
  if (spec.actual > band.max) return spec.actual - band.max;
  return 0;
}

export interface Reading extends Spec {
  key: string;
  name: string;
  unit?: string | null;
}

export interface Defect {
  key: string;
  name: string;
  department?: string | null;
}

export interface Suggestion {
  /** What the evidence requires. Never `ACCEPTED_BYPASS`: a concession is a
   *  decision a person takes, never one a calculation arrives at. */
  verdict: "HOLD" | "ACCEPTED";
  reasons: string[];
  failed: Reading[];
  unmeasured: Reading[];
  /** The department to hold against, when every defect points at the same one
   *  and so the answer is not a guess. */
  department: string | null;
}

/** The verdict the readings and the defects require.
 *
 *  An inspector may take a different one — that is what a bypass is, and what
 *  the permission for it exists to control — but the suggestion is derived
 *  from the evidence and is recomputed from the stored record afterwards. If
 *  the two ever disagree, the record was not written by this application.
 */
export function suggest(readings: Reading[], defects: Defect[]): Suggestion {
  const failed = readings.filter((r) => result(r) === "FAIL");
  const unmeasured = readings.filter((r) => result(r) === "NOT_MEASURED");

  const reasons: string[] = [];
  if (unmeasured.length > 0)
    reasons.push(`${unmeasured.length} dimension(s) not measured`);
  for (const r of failed) reasons.push(`${r.name} is outside tolerance`);
  for (const d of defects) reasons.push(`Visual defect: ${d.name}`);

  const departments = [...new Set(defects.map((d) => d.department?.trim()).filter(Boolean))];

  return {
    verdict: failed.length > 0 || unmeasured.length > 0 || defects.length > 0 ? "HOLD" : "ACCEPTED",
    reasons: reasons.length > 0 ? reasons : ["Every dimension is in tolerance and no defect was recorded"],
    failed,
    unmeasured,
    department: departments.length === 1 ? (departments[0] as string) : null,
  };
}
