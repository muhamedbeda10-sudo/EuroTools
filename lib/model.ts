/** The documents this app stores, described once.
 *
 *  The browser writes them through the Firebase Web SDK and the command-line
 *  scripts write them through the Admin SDK. The shapes belong to neither, so
 *  this module imports no SDK at all — which is also what lets it be read by
 *  `lib/domain` tests and by the rules tests without dragging a client in.
 *
 *  ## Why things are nested the way they are
 *
 *  Firestore bills per document, so the shape of the data is also the shape of
 *  the bill. Three things are embedded rather than given their own documents:
 *
 *  - a checklist's answers and measurements, inside the inspection,
 *  - a lot's certificates, inside the lot,
 *  - a material's measured features, inside the material.
 *
 *  Each of those is only ever read with its parent and only ever written with
 *  it. Embedding turns one inspection from about fifteen writes into one, and
 *  turns reading a filled-in sheet from fifteen reads into one. Nothing is
 *  lost: every answer and every measurement is still stored individually,
 *  which is what lets the "most frequent nonconformity" report exist at all,
 *  and what lets a stored verdict be checked against its own evidence.
 *
 *  Part events are a subcollection instead: the trail only grows, and it is
 *  read on one page.
 *
 *  ## Why ids are generated rather than natural
 *
 *  A document id cannot contain a slash, and shop-floor part numbers and
 *  serials contain slashes and spaces all the time. So ids are generated, and
 *  uniqueness — which a database used to enforce with an index — is held by
 *  the reservation documents in `uniques`, whose id *is* the value.
 */

/** A Firestore timestamp, from whichever SDK wrote it. Both expose `toDate`,
 *  which is all any reader here needs. */
export interface StoredTimestamp {
  toDate(): Date;
  seconds: number;
  nanoseconds: number;
}

// ───────────────────────── collection names ─────────────────────────

export const COLLECTIONS = {
  users: "users",
  userAuditEvents: "userAuditEvents",
  uniques: "uniques",
  suppliers: "suppliers",
  materials: "materials",
  lots: "lots",
  parts: "parts",
  inspections: "inspections",
  stats: "stats",
} as const;

/** Subcollections, named relative to their parent document. */
export const SUBCOLLECTIONS = {
  analyses: "analyses",
  events: "events",
  /** Defect photographs: what the inspector saw, kept beside what they wrote.
   *  Split in two on purpose — see `InspectionPhotoDoc` below. */
  photos: "photos",
  photoData: "photoData",
} as const;

// ───────────────────────── stored shapes ─────────────────────────

export interface UserDoc {
  email: string;
  displayName: string;
  role: string;
  employeeNo: string | null;
  active: boolean;
  createdAt: StoredTimestamp;
  updatedAt: StoredTimestamp;
  createdByUid: string | null;
  createdByName: string | null;
  /** Kept as a counter so the admin screen does not count inspections by
   *  reading them. */
  signedInspections: number;
}

export interface SupplierDoc {
  name: string;
  code: string | null;
  contact: string | null;
  notes: string | null;
  createdAt: StoredTimestamp;
}

export interface FeatureEntry {
  id: string;
  stage: string;
  name: string;
  kind: string;
  nominal: number | null;
  tolMinus: number;
  tolPlus: number;
  unit: string;
  critical: boolean;
  gdtSymbol: string | null;
  gdtLimit: number | null;
  sortOrder: number;
}

export interface MaterialDoc {
  partNumber: string;
  materialNumber: string | null;
  description: string | null;
  spec: string | null;
  drawingNumber: string | null;
  drawingRev: string | null;
  hardnessMin: number | null;
  hardnessMax: number | null;
  hardnessUnit: string;
  surfaceFinishRa: number | null;
  requiredCerts: string | null;
  roughingAllowance: number | null;
  createdAt: StoredTimestamp;
  features: FeatureEntry[];
  lotCount: number;
  partCount: number;
}

export interface CertificateEntry {
  id: string;
  type: string;
  number: string | null;
  issuedAt: StoredTimestamp | null;
  received: boolean;
  verified: boolean;
  notes: string | null;
}

export interface LotDoc {
  lotNumber: string;
  materialId: string;
  supplierId: string | null;
  receivedAt: StoredTimestamp;
  poNumber: string | null;
  heatNumber: string | null;
  receivedQty: number;
  unit: string;
  status: string;
  notes: string | null;
  createdAt: StoredTimestamp;
  certificates: CertificateEntry[];
  partCount: number;
  /** So the dashboard can tell which lots are waiting on their analysis
   *  without reading every analysis of every lot. */
  analysisCounts: { total: number; pending: number; accepted: number; rejected: number };
}

export interface AnalysisResultEntry {
  id: string;
  property: string;
  requiredMin: number | null;
  requiredMax: number | null;
  requiredText: string | null;
  actual: number | null;
  actualText: string | null;
  unit: string | null;
  pass: boolean | null;
  sortOrder: number;
}

export interface AnalysisDoc {
  sampleRef: string;
  method: string | null;
  performedAt: StoredTimestamp;
  /** Who ran the test; may be an outside laboratory, so it is free text. */
  performedBy: string | null;
  /** Who entered it. Always an account — the person answerable for the record. */
  recordedByUid: string;
  recordedByName: string;
  status: string;
  conclusion: string | null;
  actionTaken: string | null;
  results: AnalysisResultEntry[];
}

export interface PartDoc {
  serialNumber: string;
  materialId: string;
  lotId: string | null;
  batchQty: number;
  currentStage: string;
  status: string;
  createdAt: StoredTimestamp;
  updatedAt: StoredTimestamp;
}

export interface PartEventDoc {
  at: StoredTimestamp;
  kind: string;
  stage: string | null;
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
  actorUid: string;
  actor: string;
}

export interface CheckEntry {
  key: string;
  /** true = ok, false = not ok, null = not answered yet */
  ok: boolean | null;
  note: string | null;
}

export interface MeasurementEntry {
  featureId: string | null;
  name: string;
  kind: string;
  nominal: number | null;
  tolMinus: number;
  tolPlus: number;
  gdtLimit: number | null;
  actual: number | null;
  unit: string;
  critical: boolean;
  result: string;
  sortOrder: number;
}

export interface InspectionDoc {
  stage: string;
  partId: string | null;
  lotId: string | null;
  inspectorUid: string;
  inspector: string;
  inspectedAt: StoredTimestamp;
  status: string;
  notes: string | null;

  hardnessValue: number | null;
  hardnessUnit: string | null;
  hardnessMin: number | null;
  hardnessMax: number | null;

  surfaceFinishRa: number | null;
  cmmRequired: boolean;
  cmmReportRef: string | null;
  cmmReviewed: boolean;

  checks: CheckEntry[];
  measurements: MeasurementEntry[];

  /** Copied at write time so the reports never have to read the part, the lot
   *  and the material back just to label a row. */
  subject: string;
  partNumber: string;
  /** Lets the out-of-tolerance report ask for the fifty it needs instead of
   *  reading every inspection ever filed. */
  hasFailedMeasurement: boolean;
}

export interface UserAuditEventDoc {
  at: StoredTimestamp;
  kind: string;
  subjectUid: string;
  subjectName: string;
  actorUid: string;
  actorName: string;
  fromValue: string | null;
  toValue: string | null;
}

// ───────────────────────── uniqueness ─────────────────────────

/** The fields that used to carry a database unique constraint. */
export type UniqueScope =
  | "material.partNumber"
  | "lot.lotNumber"
  | "part.serialNumber"
  | "user.email"
  | "supplier.name";

/** Reservation key for a value.
 *
 *  Base64url, because a document id may not contain a slash and shop-floor
 *  part numbers frequently do. The `u_` prefix keeps the result clear of
 *  Firestore's reserved `__…__` pattern, and the encoding stays reversible so
 *  a reservation can still be read by a human debugging one.
 *
 *  Case and surrounding space are normalised away, so "PN-1042/a " cannot be
 *  filed as a second part alongside "PN-1042/A".
 */
export function uniqueKey(scope: UniqueScope, value: string): string {
  const normalized = value.trim().toLowerCase();
  const encoded =
    typeof Buffer !== "undefined"
      ? Buffer.from(`${scope}:${normalized}`, "utf8").toString("base64url")
      : btoa(String.fromCharCode(...new TextEncoder().encode(`${scope}:${normalized}`)))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
  return `u_${encoded}`;
}

// ───────────────────────── conversion ─────────────────────────

/** Firestore hands back timestamps; every page in this app renders Dates. */
export function toDate(value: StoredTimestamp | Date | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : value.toDate();
}

export function toDateRequired(value: StoredTimestamp | Date): Date {
  return value instanceof Date ? value : value.toDate();
}

/** A defect photograph, stored in two pieces.
 *
 *  There is no object store on this plan, so the picture lives in Firestore
 *  like everything else. That makes what it costs to *look at a list* the
 *  design problem: a traveller with five photographs on it would pull about a
 *  megabyte and a quarter every time somebody opened it, and a plan with ten
 *  gigabytes of monthly traffic does not survive that habit.
 *
 *  So the thumbnail and the full picture are separate documents sharing an id.
 *  A gallery reads only the thumbnails — about twenty kilobytes each — and the
 *  full picture is fetched when somebody actually opens one. Reading a list
 *  therefore costs roughly a twelfth of what it otherwise would.
 *
 *  Both are written in the same transaction as the inspection they belong to,
 *  and both are refused any update or delete by the rules. A photograph is
 *  part of a signed record: it is evidence for a verdict somebody put their
 *  name to, and evidence that can be swapped afterwards is not evidence.
 */
export interface InspectionPhotoDoc {
  /** A JPEG data URL, long edge 320px. Small enough to list many at once. */
  thumb: string;
  caption: string | null;
  /** Of the full picture, so a gallery can reserve the right shape before the
   *  full picture arrives and the page does not jump under a gloved hand. */
  width: number;
  height: number;
  bytes: number;
  capturedAt: StoredTimestamp;
  capturedByUid: string;
  capturedByName: string;
}

/** The full picture, addressed by the same id as its thumbnail. */
export interface InspectionPhotoDataDoc {
  /** A JPEG data URL, long edge at most 1600px. */
  data: string;
}

/** The ceiling the security rules enforce on a stored picture.
 *
 *  A Firestore document may not exceed a megabyte, and a document that is
 *  refused on arrival loses the inspection written with it. Holding the
 *  picture well under the limit leaves room for the field names and the
 *  metadata beside it, and keeps a single photograph from eating a thousandth
 *  of the plan's entire storage.
 */
export const PHOTO_MAX_BYTES = 900_000;

/** How many photographs may ride with one inspection.
 *
 *  Not an arbitrary tidiness rule. The photographs are written in the same
 *  transaction as the inspection so that neither can exist without the other,
 *  and a Firestore transaction has a size of its own to stay under. Four also
 *  happens to be more than anybody photographing one defect has ever needed.
 */
export const PHOTO_MAX_PER_INSPECTION = 4;
export const PHOTO_MAX_EDGE = 1600;
export const THUMB_MAX_EDGE = 320;

/** A stored document plus its id, which the pages use for links. */
export type WithId<T> = T & { id: string };
