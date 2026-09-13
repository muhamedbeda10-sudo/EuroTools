/** The shape of everything stored, with no SDK in it.
 *
 *  Imported by the browser and by the scripts, which use different Firestore
 *  libraries whose `Timestamp` types are not the same one. `StoredTimestamp`
 *  is the shared surface: the only thing either side needs is `toDate()`.
 *
 *  Nothing here reads or writes. The rules live in `lib/domain/`, the reads in
 *  `lib/client/queries.ts`, the writes in `lib/client/actions.ts`.
 */

import type { Stage, Verdict, PieceState } from "./domain/workflow";

export interface StoredTimestamp {
  toDate(): Date;
  toMillis(): number;
}

export const COLLECTIONS = {
  users: "users",
  userAuditEvents: "userAuditEvents",
  /** One row as planning handed it over. */
  planningLines: "planningLines",
  /** One physical piece. A line with a quantity of five makes five of these. */
  pieces: "pieces",
  /** One measurement round on one piece at one stage. */
  inspections: "inspections",
  /** One hold, from the moment it was raised to the moment it was closed. */
  reworks: "reworks",
  /** What a piece has to be: dimensions per stage, and the defects to look
   *  for. Keyed by item code. */
  itemConfigs: "itemConfigs",
  /** Settings with no natural key of their own — the department list, the
   *  defect catalogue every item starts from. */
  config: "config",
  /** Tallies the dashboard reads instead of scanning. */
  stats: "stats",
} as const;

export const SUBCOLLECTIONS = {
  /** Thumbnails a gallery lists, and the full pictures behind them. Split so
   *  that opening a list does not pull every photograph on it. */
  photos: "photos",
  photoData: "photoData",
} as const;

/** Fixed ids for the settings documents, so nothing addresses them by string
 *  literal in three places. */
export const CONFIG_DOCS = {
  departments: "departments",
  defects: "defects",
} as const;

export const STAT_DOCS = {
  /** Holds by department, and by department and stage. */
  holds: "holds",
  /** How often each defect has been seen. */
  defects: "defects",
  /** Verdicts by stage, so the dashboard never counts inspections by hand. */
  verdicts: "verdicts",
} as const;

// ───────────────────────── planning ─────────────────────────

export const MEASURING_TYPES = ["CMM", "TRADITIONAL"] as const;
export type MeasuringType = (typeof MEASURING_TYPES)[number];

export function isMeasuringType(v: unknown): v is MeasuringType {
  return typeof v === "string" && (MEASURING_TYPES as readonly string[]).includes(v);
}

/** A row of planning's sheet.
 *
 *  `plannedAt` is planning's own date — when they wrote the row — and is not
 *  the same thing as when quality first saw it. Keeping both is what lets the
 *  dashboard say whether a delay was in the queue or on the bench.
 */
export interface PlanningLineDoc {
  project: string;
  /** Planning's own second column. Carried through as typed rather than
   *  interpreted, because what it means is theirs to decide, not ours. */
  mplpr: string | null;
  itemCode: string;
  itemName: string;
  qty: number;
  measuringType: MeasuringType;
  priority: string | null;
  plannedAt: StoredTimestamp;

  createdAt: StoredTimestamp;
  updatedAt: StoredTimestamp;
  createdByUid: string;
  createdByName: string;

  /** Maintained as pieces move, so a list of lines costs one read per line
   *  rather than one per piece on it. */
  counts: LineCounts;
}

export interface LineCounts {
  total: number;
  withQc: number;
  inRework: number;
  closed: number;
  /** Every measurement taken against this line, across all of its pieces and
   *  both stages. This is what goes back to planning in their Description
   *  column: how many times a thing had to be measured before it was done. */
  measurements: number;
}

/** A line is off quality's desk when no piece on it is waiting to be measured
 *  — which is exactly what planning's `Complete` column means. */
export function lineIsComplete(counts: LineCounts): boolean {
  return counts.total > 0 && counts.withQc === 0;
}

// ───────────────────────── pieces ─────────────────────────

export interface PieceDoc {
  lineId: string;
  /** Copied from the line so a queue row is one read, not two. A line's own
   *  fields never change after import, so there is nothing to keep in step. */
  project: string;
  itemCode: string;
  itemName: string;
  measuringType: MeasuringType;
  priority: string | null;
  plannedAt: StoredTimestamp;

  pieceNo: number;
  /** What is written on the tag. Unique because the line id is in it. */
  serial: string;

  stage: Stage;
  state: PieceState;
  holdDepartment: string | null;
  /** Measurement rounds so far at the *current* stage. Reset when the piece
   *  moves on, so "held three times at finish" reads directly. */
  round: number;
  /** Every measurement this piece has ever had, across both stages. Never
   *  reset — this is the number planning asks for, and a piece measured twice
   *  at roughing and three times at finish was measured five times. */
  measuredTimes: number;

  lastVerdict: Verdict | null;
  lastInspectedAt: StoredTimestamp | null;

  /** When the current wait on quality began; null while it is elsewhere. */
  qcSince: StoredTimestamp | null;
  /** Waiting time already settled, in milliseconds. Accumulated rather than
   *  measured end to end — see `qcMillis` in `lib/domain/workflow.ts`. */
  qcSettledMs: number;

  createdAt: StoredTimestamp;
  updatedAt: StoredTimestamp;
}

// ───────────────────────── inspections ─────────────────────────

/** One dimension as it was measured, with the drawing copied in beside the
 *  reading. Copied rather than referenced so the record still reads correctly
 *  after somebody revises the item's configuration. */
export interface ReadingEntry {
  key: string;
  name: string;
  unit: string | null;
  nominal: number | null;
  tolMinus: number | null;
  tolPlus: number | null;
  actual: number | null;
  result: "PASS" | "FAIL" | "NOT_MEASURED";
  /** True when the inspector added this dimension on the sheet rather than
   *  taking it from the item's configuration. */
  adHoc: boolean;
}

export interface DefectEntry {
  key: string;
  name: string;
  note: string | null;
}

export interface InspectionDoc {
  pieceId: string;
  lineId: string;
  /** Copied so a report never reads the piece and the line back to label a
   *  row. */
  project: string;
  itemCode: string;
  itemName: string;
  serial: string;

  stage: Stage;
  round: number;

  readings: ReadingEntry[];
  defects: DefectEntry[];

  /** What the evidence required, recomputed from the stored readings by the
   *  reconciliation report. A record where these two disagree without a
   *  bypass was not written by this application. */
  suggested: "HOLD" | "ACCEPTED";
  verdict: Verdict;
  holdDepartment: string | null;
  /** Required when the verdict is a concession: why product the evidence
   *  holds was let through, and on whose authority. */
  bypassReason: string | null;

  inspectorUid: string;
  inspector: string;
  inspectedAt: StoredTimestamp;

  photoCount: number;
  hasFailedReading: boolean;
}

// ───────────────────────── reworks ─────────────────────────

export interface ReworkDoc {
  pieceId: string;
  lineId: string;
  project: string;
  itemCode: string;
  serial: string;
  stage: Stage;
  /** The round that was held, so a rework points at the sheet that caused it. */
  round: number;
  inspectionId: string;

  department: string;
  heldAt: StoredTimestamp;
  heldByUid: string;
  heldByName: string;

  /** Null while the department still has it. */
  completedAt: StoredTimestamp | null;
  /** Quality records the completion on the department's behalf, so the record
   *  says plainly whose word it is. */
  recordedByUid: string | null;
  recordedByName: string | null;
  note: string | null;
}

// ───────────────────────── configuration ─────────────────────────

export interface DimensionSpec {
  key: string;
  name: string;
  unit: string | null;
  nominal: number | null;
  tolMinus: number | null;
  tolPlus: number | null;
}

/** One line of the defect catalogue: a name, and a key the answers are stored
 *  against.
 *
 *  Nothing else. The catalogue is shared by every item, and the department
 *  responsible is chosen on the hold rather than attached to the defect —
 *  which defect was seen and who has to put it right are two different
 *  questions, and the second one has an answer the first cannot supply. */
export interface DefectSpec {
  key: string;
  name: string;
}

/** What an item has to be. Keyed by item code, so there is one of these per
 *  item no matter how many projects order it. */
export interface ItemConfigDoc {
  itemCode: string;
  itemName: string;
  dimensions: Record<Stage, DimensionSpec[]>;
  updatedAt: StoredTimestamp;
  updatedByUid: string;
  updatedByName: string;
}

export interface DepartmentsDoc {
  list: string[];
}

/** The defects every item starts from. An item with none of its own still
 *  gives the inspector something to tick, which is the difference between a
 *  defect being recorded and being remembered. */
export interface DefectCatalogueDoc {
  list: DefectSpec[];
}

// ───────────────────────── photographs ─────────────────────────

export interface InspectionPhotoDoc {
  /** A JPEG data URL, long edge 320px. Small enough to list many at once. */
  thumb: string;
  caption: string | null;
  width: number;
  height: number;
  bytes: number;
  capturedAt: StoredTimestamp;
  capturedByUid: string;
  capturedByName: string;
}

export interface InspectionPhotoDataDoc {
  /** A JPEG data URL, long edge at most 1600px. */
  data: string;
}

/** A Firestore document may not exceed a megabyte, and one refused on arrival
 *  takes the inspection written beside it down too. Holding a picture well
 *  under the limit leaves room for the fields around it. */
export const PHOTO_MAX_BYTES = 900_000;
export const PHOTO_MAX_EDGE = 1600;
export const THUMB_MAX_EDGE = 320;
export const PHOTO_MAX_PER_INSPECTION = 4;

// ───────────────────────── accounts ─────────────────────────

export interface UserDoc {
  email: string;
  displayName: string;
  role: string;
  /** How this person differs from their role. Absent on most accounts, and
   *  should be: a permission system where everybody is an exception is a
   *  permission system nobody can audit. A denial wins over a grant. */
  granted?: string[] | null;
  denied?: string[] | null;
  employeeNo: string | null;
  active: boolean;
  createdAt: StoredTimestamp;
  updatedAt: StoredTimestamp;
  createdByUid: string | null;
  createdByName: string | null;
  signedInspections: number;
}

export interface UserAuditEventDoc {
  at: StoredTimestamp;
  kind: "CREATED" | "ROLE_CHANGED" | "ACTIVATED" | "DEACTIVATED";
  subjectUid: string;
  subjectName: string;
  actorUid: string;
  actorName: string;
  fromValue: string | null;
  toValue: string | null;
}

// ───────────────────────── helpers ─────────────────────────

/** A document id from a value people type.
 *
 *  Firestore ids may not contain a slash and may not begin with two dots, and
 *  item codes on a drawing contain both slashes and spaces. Base64 with the
 *  two url-unsafe characters swapped by hand: `base64url` as a named encoding
 *  exists in Node but not in the Buffer polyfill a browser bundle gets, and
 *  the difference only shows up at runtime, in production, as an id that
 *  cannot be written.
 */
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(binary, "binary").toString("base64");
}

export function configKey(value: string): string {
  const bytes = new TextEncoder().encode(value.trim().toLowerCase());
  return `i_${base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export function toDate(value: StoredTimestamp | Date | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : value.toDate();
}

export function toDateRequired(value: StoredTimestamp | Date): Date {
  return value instanceof Date ? value : value.toDate();
}

/** A stored document plus its id, which the pages use for links. */
export type WithId<T> = T & { id: string };
