/** Turning somebody's spreadsheet into rows this application can store.
 *
 *  Pure: rows in, rows out, no file reading and no database. The part that
 *  actually opens an `.xlsx` is a dozen lines in `lib/client/spreadsheet.ts`;
 *  everything that can be wrong with a sheet is decided here, where it can be
 *  tested against the shapes real sheets arrive in.
 *
 *  The rule throughout: refuse a row rather than guess at it. A planning line
 *  imported with the wrong quantity creates the wrong number of pieces, and
 *  nobody notices until the count on the bench disagrees with the count on the
 *  screen. Every refusal names the row and what was wrong with it.
 */

import { STAGES, type Stage } from "@/lib/domain/workflow";
import { MEASURING_TYPES, type MeasuringType } from "@/lib/model";

export type Row = Record<string, unknown>;

export interface Problem {
  row: number;
  message: string;
}

export interface Parsed<T> {
  rows: T[];
  problems: Problem[];
}

/** Match a header however it was typed. Sheets arrive with trailing spaces,
 *  mixed case, and a full stop somebody added years ago. */
export function normaliseHeader(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[\s._/-]+/g, "")
    .trim();
}

/** Find a column by any of the names it might carry. Returns null rather than
 *  a guess: a column that is not there is different from a column that is
 *  empty, and only the first is worth refusing the whole sheet over. */
export function column(headers: string[], ...names: string[]): number | null {
  const wanted = names.map(normaliseHeader);
  const at = headers.findIndex((h) => wanted.includes(normaliseHeader(h)));
  return at < 0 ? null : at;
}

export function text(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

/** A number as a sheet may hold it: a real number, or a string with a comma
 *  for a decimal point, or a unit somebody typed after it. */
export function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = text(value);
  if (s == null) return null;

  const cleaned = s.replace(/,/g, ".").replace(/[^0-9.+-eE]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === "+") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** A date as a sheet may hold it: a real date, a serial number from Excel's
 *  own epoch, or something typed by hand. Day-first is assumed for an
 *  ambiguous slash date, which is what this plant writes. */
export function date(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel counts days from 1899-12-30 — the offset that absorbs its
    // deliberate 1900 leap-year bug.
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const s = text(value);
  if (s == null) return null;

  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (dmy) {
    const [, d1, m1, y1] = dmy;
    const year = Number(y1) < 100 ? 2000 + Number(y1) : Number(y1);
    const parsed = new Date(Date.UTC(year, Number(m1) - 1, Number(d1)));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function measuringType(value: unknown): MeasuringType | null {
  const s = normaliseHeader(value);
  if (s === "") return null;
  if (s.startsWith("cmm")) return "CMM";
  if (s.startsWith("trad") || s.startsWith("manual") || s.startsWith("conv")) return "TRADITIONAL";
  const upper = String(value).trim().toUpperCase();
  return (MEASURING_TYPES as readonly string[]).includes(upper) ? (upper as MeasuringType) : null;
}

export function stage(value: unknown): Stage | null {
  const s = normaliseHeader(value);
  if (s.startsWith("rough")) return "ROUGHING";
  if (s.startsWith("fin")) return "FINISH";
  const upper = String(value).trim().toUpperCase();
  return (STAGES as readonly string[]).includes(upper) ? (upper as Stage) : null;
}

// ───────────────────────── the planning sheet ─────────────────────────

export interface PlanningRow {
  project: string;
  mplpr: string | null;
  itemCode: string;
  itemName: string;
  qty: number;
  measuringType: MeasuringType;
  priority: string | null;
  plannedAt: Date;
}

export const PLANNING_COLUMNS = [
  "Project",
  "MPLPR",
  "Item",
  "Name",
  "Qty",
  "Measuring type",
  "Date",
  "Priority",
];

/** `Duration`, `Description` and `Complete` are read past deliberately. All
 *  three are answers this application works out and hands back — how long a
 *  piece sat with quality, how many times it had to be measured, and whether
 *  it is still here. Reading planning's guess at any of them would put a
 *  number on the dashboard that nothing here can account for. */
export function parsePlanning(grid: unknown[][]): Parsed<PlanningRow> {
  const problems: Problem[] = [];
  if (grid.length < 2) return { rows: [], problems: [{ row: 0, message: "The sheet is empty." }] };

  const headers = grid[0].map((h) => String(h ?? ""));
  const at = {
    project: column(headers, "project", "projectno", "project number"),
    mplpr: column(headers, "mplpr", "mp", "mpl"),
    item: column(headers, "item", "itemcode", "item no", "code"),
    name: column(headers, "name", "itemname", "description name"),
    qty: column(headers, "qty", "quantity", "pcs"),
    measuring: column(headers, "measuringtype", "measuring", "type", "method"),
    date: column(headers, "date", "planneddate", "plandate"),
    priority: column(headers, "priority", "prio"),
  };

  const missing = (["project", "item", "qty"] as const).filter((k) => at[k] == null);
  if (missing.length > 0)
    return {
      rows: [],
      problems: [
        {
          row: 1,
          message: `The sheet needs these columns and does not have them: ${missing.join(", ")}. Expected headings: ${PLANNING_COLUMNS.join(", ")}.`,
        },
      ],
    };

  const rows: PlanningRow[] = [];
  const cell = (r: unknown[], i: number | null) => (i == null ? null : r[i]);

  for (let i = 1; i < grid.length; i += 1) {
    const raw = grid[i];
    const line = i + 1;
    if (!raw || raw.every((c) => text(c) == null)) continue;

    const project = text(cell(raw, at.project));
    const itemCode = text(cell(raw, at.item));
    const qty = num(cell(raw, at.qty));

    if (!project) {
      problems.push({ row: line, message: "No project number." });
      continue;
    }
    if (!itemCode) {
      problems.push({ row: line, message: "No item." });
      continue;
    }
    if (qty == null || !Number.isInteger(qty) || qty < 1) {
      problems.push({ row: line, message: `Quantity "${text(cell(raw, at.qty)) ?? ""}" is not a whole number of pieces.` });
      continue;
    }

    const measuring = measuringType(cell(raw, at.measuring));
    if (measuring == null) {
      // Not a guess worth making: it decides whether the piece goes to the CMM
      // or to the bench.
      problems.push({ row: line, message: "Measuring type has to be CMM or Traditional." });
      continue;
    }

    // A row with no date of its own is planning's row from today; refusing it
    // would stop an import over a blank cell nobody fills in.
    const plannedAt = date(cell(raw, at.date)) ?? new Date();

    rows.push({
      project,
      mplpr: text(cell(raw, at.mplpr)),
      itemCode,
      itemName: text(cell(raw, at.name)) ?? itemCode,
      qty,
      measuringType: measuring,
      priority: text(cell(raw, at.priority)),
      plannedAt,
    });
  }

  return { rows, problems };
}

// ───────────────────────── the configuration sheet ─────────────────────────

export interface DimensionRow {
  itemCode: string;
  itemName: string | null;
  stage: Stage;
  name: string;
  unit: string | null;
  nominal: number | null;
  tolMinus: number | null;
  tolPlus: number | null;
}

export const DIMENSION_COLUMNS = [
  "Item",
  "Name",
  "Stage",
  "Dimension",
  "Unit",
  "Nominal",
  "Tol -",
  "Tol +",
];

export function parseDimensions(grid: unknown[][]): Parsed<DimensionRow> {
  const problems: Problem[] = [];
  if (grid.length < 2) return { rows: [], problems: [{ row: 0, message: "The sheet is empty." }] };

  const headers = grid[0].map((h) => String(h ?? ""));
  const at = {
    item: column(headers, "item", "itemcode", "code"),
    name: column(headers, "itemname", "name"),
    stage: column(headers, "stage", "operation", "op"),
    dimension: column(headers, "dimension", "feature", "characteristic", "dim"),
    unit: column(headers, "unit", "uom"),
    nominal: column(headers, "nominal", "nom", "target"),
    tolMinus: column(headers, "tol-", "tolminus", "lowertolerance", "minus", "lower"),
    tolPlus: column(headers, "tol+", "tolplus", "uppertolerance", "plus", "upper"),
  };

  const missing = (["item", "stage", "dimension"] as const).filter((k) => at[k] == null);
  if (missing.length > 0)
    return {
      rows: [],
      problems: [
        {
          row: 1,
          message: `The sheet needs these columns and does not have them: ${missing.join(", ")}. Expected headings: ${DIMENSION_COLUMNS.join(", ")}.`,
        },
      ],
    };

  const rows: DimensionRow[] = [];
  const cell = (r: unknown[], i: number | null) => (i == null ? null : r[i]);

  for (let i = 1; i < grid.length; i += 1) {
    const raw = grid[i];
    const line = i + 1;
    if (!raw || raw.every((c) => text(c) == null)) continue;

    const itemCode = text(cell(raw, at.item));
    const name = text(cell(raw, at.dimension));
    const st = stage(cell(raw, at.stage));

    if (!itemCode) {
      problems.push({ row: line, message: "No item." });
      continue;
    }
    if (!name) {
      problems.push({ row: line, message: "No dimension name." });
      continue;
    }
    if (!st) {
      problems.push({ row: line, message: "Stage has to be Roughing or Finish." });
      continue;
    }

    rows.push({
      itemCode,
      itemName: text(cell(raw, at.name)),
      stage: st,
      name,
      unit: text(cell(raw, at.unit)),
      nominal: num(cell(raw, at.nominal)),
      // Stored as magnitudes: a minus tolerance typed as "-0.02" and as "0.02"
      // mean the same thing, and neither may widen the band upwards.
      tolMinus: abs(num(cell(raw, at.tolMinus))),
      tolPlus: abs(num(cell(raw, at.tolPlus))),
    });
  }

  return { rows, problems };
}

const abs = (n: number | null) => (n == null ? null : Math.abs(n));

export interface DefectRow {
  /** Blank means the defect belongs to every item, not to one. */
  itemCode: string | null;
  name: string;
  department: string | null;
}

export const DEFECT_COLUMNS = ["Item", "Defect", "Department"];

export function parseDefects(grid: unknown[][]): Parsed<DefectRow> {
  const problems: Problem[] = [];
  if (grid.length < 2) return { rows: [], problems: [{ row: 0, message: "The sheet is empty." }] };

  const headers = grid[0].map((h) => String(h ?? ""));
  const at = {
    item: column(headers, "item", "itemcode", "code"),
    defect: column(headers, "defect", "visualdefect", "name", "description"),
    department: column(headers, "department", "dept", "responsible", "section"),
  };

  if (at.defect == null)
    return {
      rows: [],
      problems: [
        {
          row: 1,
          message: `The sheet needs a Defect column. Expected headings: ${DEFECT_COLUMNS.join(", ")}.`,
        },
      ],
    };

  const rows: DefectRow[] = [];
  const cell = (r: unknown[], i: number | null) => (i == null ? null : r[i]);

  for (let i = 1; i < grid.length; i += 1) {
    const raw = grid[i];
    if (!raw || raw.every((c) => text(c) == null)) continue;

    const name = text(cell(raw, at.defect));
    if (!name) {
      problems.push({ row: i + 1, message: "No defect name." });
      continue;
    }

    rows.push({
      itemCode: text(cell(raw, at.item)),
      name,
      department: text(cell(raw, at.department)),
    });
  }

  return { rows, problems };
}
