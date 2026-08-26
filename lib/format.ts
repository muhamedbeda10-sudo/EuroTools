/** Display helpers shared by the pages.
 *
 *  Dates are assembled from `formatToParts` rather than handed to
 *  `Intl.DateTimeFormat.format`: Node and the browser ship different ICU
 *  versions and disagree on the Arabic date/time separator, which shows up as
 *  a hydration mismatch the moment a date is rendered inside a Client
 *  Component. Taking only the numeric parts and joining them ourselves gives
 *  byte-identical output on both sides.
 *
 *  The timezone is pinned for the same reason — the server and the browser
 *  are not necessarily in the same one. Override with QC_TIME_ZONE.
 */

const TIME_ZONE = process.env.NEXT_PUBLIC_QC_TIME_ZONE || "Africa/Cairo";

const PARTS_FMT = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function dateParts(d: Date): Record<string, string> {
  return Object.fromEntries(
    PARTS_FMT.formatToParts(d).map((p) => [p.type, p.value])
  );
}

function asDate(d: Date | string): Date | null {
  const v = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(v.getTime()) ? null : v;
}

export function fmtDate(d: Date | string | null | undefined): string {
  const v = d == null ? null : asDate(d);
  if (!v) return "—";
  const p = dateParts(v);
  return `${p.day}/${p.month}/${p.year}`;
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  const v = d == null ? null : asDate(d);
  if (!v) return "—";
  const p = dateParts(v);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

/** Today as `YYYY-MM-DD` for a date input — in the app's timezone, so a
 *  late-evening entry does not default to tomorrow. */
export function todayInputValue(now: Date = new Date()): string {
  const p = dateParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Trim trailing zeros so 50.0500 reads as 50.05 but 50 stays 50. */
export function fmtNum(n: number | null | undefined, maxDigits = 4): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: maxDigits });
}

/** "50 ‎±0.05" or "50 +0.1/-0" for an asymmetric band. */
export function fmtTolerance(
  nominal: number | null | undefined,
  tolMinus: number | null | undefined,
  tolPlus: number | null | undefined
): string {
  if (nominal == null) return "—";
  const minus = Math.abs(tolMinus ?? 0);
  const plus = Math.abs(tolPlus ?? 0);
  if (minus === 0 && plus === 0) return fmtNum(nominal);
  if (minus === plus) return `${fmtNum(nominal)} ±${fmtNum(plus)}`;
  return `${fmtNum(nominal)} +${fmtNum(plus)}/-${fmtNum(minus)}`;
}

export function pct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

/** Parse a form field that may legitimately be blank. */
export function optionalNumber(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function optionalString(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
}

/** Tri-state radio: "yes" | "no" | "" (unanswered). */
export function triState(v: FormDataEntryValue | null): boolean | null {
  const s = String(v ?? "").trim();
  if (s === "yes") return true;
  if (s === "no") return false;
  return null;
}
