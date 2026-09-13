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

/** Everything here compares whole numbers on a decimal grid rather than the
 *  doubles the values arrive as.
 *
 *  This is not fussiness. `100.7 - 0.1` is `100.60000000000001` in binary
 *  floating point, so a part measured at exactly 100.6 — sitting precisely on
 *  its lower limit, which the shop floor passes — came out as FAIL. Swept
 *  across ordinary drawing values, about one on-limit reading in eight was
 *  rejected this way. It never accepted anything out of tolerance, so the
 *  error only ever cost good parts: held, sent back for rework they did not
 *  need, and counted against the first-pass rate.
 *
 *  A drawing is written in decimals and so is the reading taken against it.
 *  Scaling both onto the finest grid either of them uses turns the comparison
 *  into integer arithmetic, where 100.7 − 0.1 is 100.6 and nothing else.
 */

/** How many decimal places a number is written to. */
function decimalPlaces(value: number): number {
  if (!Number.isFinite(value) || Number.isInteger(value)) return 0;

  const text = String(value);
  const e = text.indexOf("e");
  if (e === -1) {
    const dot = text.indexOf(".");
    return dot === -1 ? 0 : text.length - dot - 1;
  }

  // Exponent form, as small tolerances print: 1e-7, 1.5e-7.
  const mantissa = text.slice(0, e);
  const dot = mantissa.indexOf(".");
  const written = dot === -1 ? 0 : mantissa.length - dot - 1;
  return Math.max(0, written - Number(text.slice(e + 1)));
}

/** Deep enough for any drawing, shallow enough that every scaled value stays a
 *  whole number a double can hold exactly. */
const MAX_PLACES = 9;

function gridFactor(...values: number[]): number {
  return 10 ** Math.min(MAX_PLACES, Math.max(0, ...values.map(decimalPlaces)));
}

const onGrid = (value: number, factor: number): number => Math.round(value * factor);

export function toleranceBand(spec: Spec): { min: number; max: number } | null {
  if (spec.nominal == null || !Number.isFinite(spec.nominal)) return null;

  const minus = Math.abs(spec.tolMinus ?? 0);
  const plus = Math.abs(spec.tolPlus ?? 0);
  const factor = gridFactor(spec.nominal, minus, plus);
  const nominal = onGrid(spec.nominal, factor);

  // Divided back so the band reads as the decimal it is — both to compare
  // against and to put on the screen, where 50.800000000000004 was showing.
  return {
    min: (nominal - onGrid(minus, factor)) / factor,
    max: (nominal + onGrid(plus, factor)) / factor,
  };
}

/** A reading exactly on a limit passes. That is the convention the shop floor
 *  works to, and it is stated here rather than left to a `<` somebody might
 *  later "tidy" into a `<=` or the other way about. */
export function result(spec: Spec): Result {
  if (spec.actual == null || !Number.isFinite(spec.actual)) return "NOT_MEASURED";
  const band = toleranceBand(spec);
  if (!band) return "NOT_MEASURED";

  const factor = gridFactor(spec.actual, band.min, band.max);
  const actual = onGrid(spec.actual, factor);
  return actual >= onGrid(band.min, factor) && actual <= onGrid(band.max, factor)
    ? "PASS"
    : "FAIL";
}

/** How far outside the band a reading sits; zero when it is inside. Sorts a
 *  report worst-first, and tells a machinist how much to take off. */
export function deviation(spec: Spec): number | null {
  if (spec.actual == null || !Number.isFinite(spec.actual)) return null;
  const band = toleranceBand(spec);
  if (!band) return null;

  const factor = gridFactor(spec.actual, band.min, band.max);
  const actual = onGrid(spec.actual, factor);
  const min = onGrid(band.min, factor);
  const max = onGrid(band.max, factor);

  if (actual < min) return (actual - min) / factor;
  if (actual > max) return (actual - max) / factor;
  return 0;
}

export interface Reading extends Spec {
  key: string;
  name: string;
  unit?: string | null;
}

/** A defect, as the sheet records it.
 *
 *  A name and nothing else. It used to carry the department responsible for
 *  it, which filled the hold's department in for the inspector whenever every
 *  ticked defect agreed on one. That saved a click and cost a screen: every
 *  defect in the catalogue needed a department set up beside it, and every
 *  defect on the sheet came with a dropdown of its own. The inspector chooses
 *  the department once, on the hold, where the decision actually belongs. */
export interface Defect {
  key: string;
  name: string;
}

export interface Suggestion {
  /** What the evidence requires. Never `ACCEPTED_BYPASS`: a concession is a
   *  decision a person takes, never one a calculation arrives at. */
  verdict: "HOLD" | "ACCEPTED";
  reasons: string[];
  failed: Reading[];
  unmeasured: Reading[];
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

  return {
    verdict: failed.length > 0 || unmeasured.length > 0 || defects.length > 0 ? "HOLD" : "ACCEPTED",
    reasons: reasons.length > 0 ? reasons : ["Every dimension is in tolerance and no defect was recorded"],
    failed,
    unmeasured,
  };
}
