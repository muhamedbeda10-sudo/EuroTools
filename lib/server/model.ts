import "server-only";

import { Timestamp, type DocumentData, type Transaction } from "firebase-admin/firestore";

import { db } from "@/lib/server/firestore";

/** The Firestore layout, and the rules that keep it honest.
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
 *  which is what lets the "most frequent nonconformity" report exist at all.
 *  A sheet runs to a few kilobytes against a one-megabyte document limit.
 *
 *  Part events are a subcollection instead: the trail only grows, and it is
 *  read on one page.
 *
 *  ## Why ids are generated rather than natural
 *
 *  A document id cannot contain a slash, and shop-floor part numbers and
 *  serials contain slashes and spaces all the time. So ids are generated, and
 *  uniqueness — which the database used to enforce with a constraint — is held
 *  by the reservation documents below.
 */

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
} as const;

// ───────────────────────── stored shapes ─────────────────────────

export interface UserDoc {
  email: string;
  displayName: string;
  role: string;
  employeeNo: string | null;
  active: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
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
  createdAt: Timestamp;
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
  createdAt: Timestamp;
  features: FeatureEntry[];
  lotCount: number;
  partCount: number;
}

export interface CertificateEntry {
  id: string;
  type: string;
  number: string | null;
  issuedAt: Timestamp | null;
  received: boolean;
  verified: boolean;
  notes: string | null;
}

export interface LotDoc {
  lotNumber: string;
  materialId: string;
  supplierId: string | null;
  receivedAt: Timestamp;
  poNumber: string | null;
  heatNumber: string | null;
  receivedQty: number;
  unit: string;
  status: string;
  notes: string | null;
  createdAt: Timestamp;
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
  performedAt: Timestamp;
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
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PartEventDoc {
  at: Timestamp;
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
  inspectedAt: Timestamp;
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
  at: Timestamp;
  kind: string;
  subjectUid: string;
  subjectName: string;
  actorUid: string;
  actorName: string;
  fromValue: string | null;
  toValue: string | null;
}

// ───────────────────────── collection handles ─────────────────────────

export const users = () => db().collection(COLLECTIONS.users);
export const userAuditEvents = () => db().collection(COLLECTIONS.userAuditEvents);
export const uniques = () => db().collection(COLLECTIONS.uniques);
export const suppliers = () => db().collection(COLLECTIONS.suppliers);
export const materials = () => db().collection(COLLECTIONS.materials);
export const lots = () => db().collection(COLLECTIONS.lots);
export const parts = () => db().collection(COLLECTIONS.parts);
export const inspections = () => db().collection(COLLECTIONS.inspections);
export const stats = () => db().collection(COLLECTIONS.stats);

export const analysesOf = (lotId: string) => lots().doc(lotId).collection(SUBCOLLECTIONS.analyses);
export const eventsOf = (partId: string) => parts().doc(partId).collection(SUBCOLLECTIONS.events);

// ───────────────────────── uniqueness ─────────────────────────

/** The fields that used to carry a database unique constraint. */
export type UniqueScope = "material.partNumber" | "lot.lotNumber" | "part.serialNumber" | "user.email" | "supplier.name";

/** Reservation key for a value.
 *
 *  Base64url, because a document id may not contain a slash and shop-floor
 *  part numbers frequently do. The `u_` prefix keeps the result clear of
 *  Firestore's reserved `__…__` pattern, and the encoding stays reversible so
 *  a reservation can still be read by a human debugging one.
 */
export function uniqueKey(scope: UniqueScope, value: string): string {
  const normalized = value.trim().toLowerCase();
  return `u_${Buffer.from(`${scope}:${normalized}`, "utf8").toString("base64url")}`;
}

/** Claim a value inside a transaction, or say who already holds it.
 *
 *  Firestore has no unique index, so uniqueness is a document whose id *is*
 *  the value: two writers racing for the same part number both try to create
 *  the same document, and Firestore lets exactly one of them win. This has to
 *  run in the same transaction as the write it protects, or a crash between
 *  the two leaves a reservation pointing at nothing.
 */
export async function reserveUnique(
  tx: Transaction,
  scope: UniqueScope,
  value: string,
  ownerPath: string
): Promise<{ ok: true } | { ok: false; ownerPath: string }> {
  const ref = uniques().doc(uniqueKey(scope, value));
  const existing = await tx.get(ref);

  if (existing.exists) {
    const owner = (existing.data() as { ownerPath?: string } | undefined)?.ownerPath ?? "";
    if (owner === ownerPath) return { ok: true };
    return { ok: false, ownerPath: owner };
  }

  tx.create(ref, { scope, value: value.trim(), ownerPath, at: Timestamp.now() });
  return { ok: true };
}

/** Give a value back, when a record is renamed onto a different one. */
export function releaseUnique(tx: Transaction, scope: UniqueScope, value: string): void {
  tx.delete(uniques().doc(uniqueKey(scope, value)));
}

/** A fresh Firestore id, for entries embedded in a document.
 *
 *  Embedded checklist answers, certificates and features still need something
 *  stable to address them by — a form posts back "the actual value for feature
 *  X" — and Firestore only generates ids through a collection handle. This
 *  names what is happening so the handle it borrows does not read as a write
 *  to that collection.
 */
export function newId(): string {
  return db().collection("_ids").doc().id;
}

// ───────────────────────── conversion ─────────────────────────

/** Firestore hands back Timestamps; every page in this app renders Dates. */
export function toDate(value: Timestamp | Date | null | undefined): Date | null {
  if (value == null) return null;
  return value instanceof Timestamp ? value.toDate() : value;
}

export function toDateRequired(value: Timestamp | Date): Date {
  return value instanceof Timestamp ? value.toDate() : value;
}

/** A stored document plus its id, which the pages use for links. */
export type WithId<T> = T & { id: string };

export function withId<T extends DocumentData>(
  snapshot: { id: string; data(): DocumentData | undefined }
): WithId<T> {
  return { id: snapshot.id, ...(snapshot.data() as T) };
}
