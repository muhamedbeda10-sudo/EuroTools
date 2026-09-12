"use client";

import {
  getAggregateFromServer,
  count,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type DocumentSnapshot,
  type Query,
  type QueryDocumentSnapshot,
} from "firebase/firestore";

import { qcMillis, type Stage } from "@/lib/domain/workflow";
import {
  CONFIG_DOCS,
  STAT_DOCS,
  configKey,
  toDate,
  toDateRequired,
  type DefectCatalogueDoc,
  type DefectSpec,
  type DepartmentsDoc,
  type InspectionDoc,
  type InspectionPhotoDataDoc,
  type InspectionPhotoDoc,
  type ItemConfigDoc,
  type PieceDoc,
  type PlanningLineDoc,
  type ReworkDoc,
} from "@/lib/model";
import {
  config,
  docIn,
  inspections,
  itemConfigs,
  photoDataOf,
  photosOf,
  pieces,
  planningLines,
  reworks,
  stats,
  userAuditEvents,
  users,
} from "@/lib/client/db";

/** Reads, and nothing else.
 *
 *  Every one of these runs in the browser against `firestore.rules`, so a page
 *  that asks for something the account may not see gets a refusal rather than
 *  an empty list. `Async` renders that refusal as the sentence it is.
 *
 *  Two habits throughout, both about what the free plan allows:
 *
 *   - what a list needs is copied onto the row, so drawing a queue is one read
 *     per row rather than three;
 *   - what a report counts is counted by Firestore or kept in a tally, never
 *     by reading the documents and counting them here.
 */

const asDoc = <T>(snapshot: QueryDocumentSnapshot | DocumentSnapshot): T => snapshot.data() as T;

async function countOf(q: Query): Promise<number> {
  return (await getAggregateFromServer(q, { n: count() })).data().n;
}

// ───────────────────────── the queues ─────────────────────────

export interface QueueRow {
  id: string;
  lineId: string;
  project: string;
  itemCode: string;
  itemName: string;
  serial: string;
  pieceNo: number;
  measuringType: string;
  priority: string | null;
  stage: Stage;
  state: PieceDoc["state"];
  holdDepartment: string | null;
  round: number;
  /** Every measurement this piece has had, across both stages. */
  measuredTimes: number;
  plannedAt: Date;
  lastInspectedAt: Date | null;
  /** How long this piece has cost quality so far, including the wait in
   *  progress. Computed here rather than stored, because a stored figure would
   *  be wrong between the moment it is written and the moment it is read. */
  qcMs: number;
}

function toQueueRow(id: string, data: PieceDoc, now: Date): QueueRow {
  return {
    id,
    lineId: data.lineId,
    project: data.project,
    itemCode: data.itemCode,
    itemName: data.itemName,
    serial: data.serial,
    pieceNo: data.pieceNo,
    measuringType: data.measuringType,
    priority: data.priority,
    stage: data.stage,
    state: data.state,
    holdDepartment: data.holdDepartment,
    round: data.round,
    measuredTimes: data.measuredTimes ?? 0,
    plannedAt: toDateRequired(data.plannedAt),
    lastInspectedAt: toDate(data.lastInspectedAt),
    qcMs: qcMillis(data.qcSettledMs ?? 0, toDate(data.qcSince), now),
  };
}

/** Highest priority first, then the longest wait. `A` before `B` before `C`
 *  is what the sheet means, and an empty priority sorts last rather than
 *  jumping the queue. */
export function byUrgency(a: QueueRow, b: QueueRow): number {
  const pa = a.priority?.trim() || "￿";
  const pb = b.priority?.trim() || "￿";
  return pa.localeCompare(pb) || a.plannedAt.getTime() - b.plannedAt.getTime();
}

/** Everything standing at one stage: what quality has to measure, and what a
 *  department still owes back. Both in one read, because the queue screen
 *  shows both and a second query would cost a second read per view. */
export async function getQueue(stage: Stage) {
  const snapshot = await getDocs(
    query(
      pieces(),
      where("stage", "==", stage),
      where("state", "in", ["WAITING_QC", "WAITING_REWORK"]),
      orderBy("plannedAt", "asc")
    )
  );

  const now = new Date();
  const rows = snapshot.docs.map((d) => toQueueRow(d.id, asDoc<PieceDoc>(d), now));
  return {
    toMeasure: rows.filter((r) => r.state === "WAITING_QC").sort(byUrgency),
    inRework: rows.filter((r) => r.state === "WAITING_REWORK").sort(byUrgency),
  };
}

// ───────────────────────── one piece ─────────────────────────

export async function getPiece(pieceId: string) {
  const snapshot = await getDoc(docIn(pieces(), pieceId));
  if (!snapshot.exists()) return null;
  const piece = asDoc<PieceDoc>(snapshot);

  const [lineSnap, historySnap, reworkSnap, itemSnap, departments, catalogue] = await Promise.all([
    getDoc(docIn(planningLines(), piece.lineId)),
    getDocs(query(inspections(), where("pieceId", "==", pieceId), orderBy("inspectedAt", "desc"))),
    getDocs(query(reworks(), where("pieceId", "==", pieceId), orderBy("heldAt", "desc"))),
    getDoc(docIn(itemConfigs(), configKey(piece.itemCode))),
    getDepartments(),
    getDefectCatalogue(),
  ]);

  const item = itemSnap.exists() ? asDoc<ItemConfigDoc>(itemSnap) : null;

  return {
    piece: toQueueRow(snapshot.id, piece, new Date()),
    line: lineSnap.exists()
      ? { id: lineSnap.id, ...asDoc<PlanningLineDoc>(lineSnap) }
      : null,
    history: historySnap.docs.map((d) => {
      const data = asDoc<InspectionDoc>(d);
      return { ...data, id: d.id, inspectedAt: toDateRequired(data.inspectedAt) };
    }),
    reworkHistory: reworkSnap.docs.map((d) => {
      const data = asDoc<ReworkDoc>(d);
      return {
        ...data,
        id: d.id,
        heldAt: toDateRequired(data.heldAt),
        completedAt: toDate(data.completedAt),
      };
    }),
    /** What to ask for at this stage: the item's own dimensions, and the
     *  defects to look for — the item's, falling back to the catalogue so an
     *  unconfigured item still gives the inspector something to tick. */
    dimensions: item?.dimensions?.[piece.stage] ?? [],
    defects: item && item.defects.length > 0 ? item.defects : catalogue,
    departments,
    itemConfigured: item != null,
  };
}

// ───────────────────────── planning ─────────────────────────

export async function getPlanningLines() {
  const snapshot = await getDocs(query(planningLines(), orderBy("plannedAt", "desc"), limit(500)));
  return snapshot.docs.map((d) => {
    const data = asDoc<PlanningLineDoc>(d);
    return {
      ...data,
      id: d.id,
      plannedAt: toDateRequired(data.plannedAt),
      createdAt: toDateRequired(data.createdAt),
    };
  });
}

export async function getLine(lineId: string) {
  const [lineSnap, pieceSnap] = await Promise.all([
    getDoc(docIn(planningLines(), lineId)),
    getDocs(query(pieces(), where("lineId", "==", lineId), orderBy("pieceNo", "asc"))),
  ]);
  if (!lineSnap.exists()) return null;

  const data = asDoc<PlanningLineDoc>(lineSnap);
  const now = new Date();
  return {
    line: { ...data, id: lineSnap.id, plannedAt: toDateRequired(data.plannedAt) },
    pieces: pieceSnap.docs.map((d) => toQueueRow(d.id, asDoc<PieceDoc>(d), now)),
  };
}

// ───────────────────────── configuration ─────────────────────────

export async function getDepartments(): Promise<string[]> {
  const snapshot = await getDoc(docIn(config(), CONFIG_DOCS.departments));
  return snapshot.exists() ? ((snapshot.data() as DepartmentsDoc).list ?? []) : [];
}

export async function getDefectCatalogue(): Promise<DefectSpec[]> {
  const snapshot = await getDoc(docIn(config(), CONFIG_DOCS.defects));
  return snapshot.exists() ? ((snapshot.data() as DefectCatalogueDoc).list ?? []) : [];
}

export async function getItemConfigs() {
  const snapshot = await getDocs(query(itemConfigs(), orderBy("itemCode", "asc")));
  return snapshot.docs.map((d) => {
    const data = asDoc<ItemConfigDoc>(d);
    return { ...data, id: d.id, updatedAt: toDateRequired(data.updatedAt) };
  });
}

export async function getConfiguration() {
  const [items, departments, catalogue] = await Promise.all([
    getItemConfigs(),
    getDepartments(),
    getDefectCatalogue(),
  ]);
  return { items, departments, catalogue };
}

export async function getItemConfig(itemCode: string) {
  const snapshot = await getDoc(docIn(itemConfigs(), configKey(itemCode)));
  if (!snapshot.exists()) return null;
  const data = asDoc<ItemConfigDoc>(snapshot);
  return { ...data, id: snapshot.id, updatedAt: toDateRequired(data.updatedAt) };
}

// ───────────────────────── photographs ─────────────────────────

export async function getInspectionPhotos(inspectionId: string) {
  const snapshot = await getDocs(query(photosOf(inspectionId), orderBy("capturedAt", "asc")));
  return snapshot.docs.map((d) => {
    const data = asDoc<InspectionPhotoDoc>(d);
    return { ...data, id: d.id, capturedAt: toDateRequired(data.capturedAt) };
  });
}

export async function getPhotoData(inspectionId: string, photoId: string): Promise<string | null> {
  const snapshot = await getDoc(docIn(photoDataOf(inspectionId), photoId));
  if (!snapshot.exists()) return null;
  return (snapshot.data() as InspectionPhotoDataDoc).data;
}

// ───────────────────────── the dashboard ─────────────────────────

export async function getDashboard() {
  const byState = (stage: Stage, state: string) =>
    countOf(query(pieces(), where("stage", "==", stage), where("state", "==", state)));

  const [
    roughingQc,
    roughingRework,
    finishQc,
    finishRework,
    closed,
    totalPieces,
    lines,
    holdsSnap,
    defectsSnap,
    verdictsSnap,
    oldest,
    recent,
  ] = await Promise.all([
    byState("ROUGHING", "WAITING_QC"),
    byState("ROUGHING", "WAITING_REWORK"),
    byState("FINISH", "WAITING_QC"),
    byState("FINISH", "WAITING_REWORK"),
    countOf(query(pieces(), where("state", "==", "CLOSED"))),
    countOf(query(pieces())),
    countOf(query(planningLines())),
    getDoc(docIn(stats(), STAT_DOCS.holds)),
    getDoc(docIn(stats(), STAT_DOCS.defects)),
    getDoc(docIn(stats(), STAT_DOCS.verdicts)),
    getDocs(
      query(pieces(), where("state", "==", "WAITING_QC"), orderBy("plannedAt", "asc"), limit(10))
    ),
    getDocs(query(inspections(), orderBy("inspectedAt", "desc"), limit(12))),
  ]);

  const tally = (snapshot: DocumentSnapshot) =>
    (snapshot.data()?.counts ?? {}) as Record<string, number>;

  const verdicts = tally(verdictsSnap);
  const accepted = (verdicts["ACCEPTED"] ?? 0) + (verdicts["ACCEPTED_BYPASS"] ?? 0);
  const held = verdicts["HOLD"] ?? 0;
  const now = new Date();

  return {
    totals: {
      lines,
      pieces: totalPieces,
      closed,
      withQc: roughingQc + finishQc,
      inRework: roughingRework + finishRework,
    },
    stages: {
      ROUGHING: { waiting: roughingQc, rework: roughingRework },
      FINISH: { waiting: finishQc, rework: finishRework },
    },
    /** Of the decisions taken, how many let the piece through. Counted from
     *  the tally, so it costs one read however many inspections there are. */
    firstPassRate: accepted + held > 0 ? (accepted / (accepted + held)) * 100 : null,
    bypasses: verdicts["ACCEPTED_BYPASS"] ?? 0,
    holdsByDepartment: Object.entries(tally(holdsSnap))
      .filter(([k]) => !k.includes("::"))
      .map(([department, n]) => ({ department, n }))
      .sort((a, b) => b.n - a.n),
    topDefects: Object.entries(tally(defectsSnap))
      .map(([key, n]) => ({ key, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 10),
    oldestWaiting: oldest.docs.map((d) => toQueueRow(d.id, asDoc<PieceDoc>(d), now)).sort(byUrgency),
    recentInspections: recent.docs.map((d) => {
      const data = asDoc<InspectionDoc>(d);
      return { ...data, id: d.id, inspectedAt: toDateRequired(data.inspectedAt) };
    }),
  };
}

// ───────────────────────── accounts ─────────────────────────

export function toUserRow(id: string, data: import("@/lib/model").UserDoc) {
  return {
    ...data,
    id,
    // Nullable: the first administrator's document is created by hand in the
    // console, before there is an application to create it, and carries only
    // the fields the README asks for.
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
    createdBy: data.createdByName ? { displayName: data.createdByName } : null,
    signedInspections: data.signedInspections ?? 0,
  };
}

export function byActiveThenName(
  a: { active: boolean; displayName: string },
  b: { active: boolean; displayName: string }
) {
  return Number(b.active) - Number(a.active) || a.displayName.localeCompare(b.displayName);
}

export async function getUsers() {
  const [userSnap, eventSnap] = await Promise.all([
    getDocs(query(users(), orderBy("displayName", "asc"))),
    getDocs(query(userAuditEvents(), orderBy("at", "desc"), limit(50))),
  ]);

  return {
    users: userSnap.docs
      .map((d) => toUserRow(d.id, asDoc(d)))
      .sort(byActiveThenName),
    events: eventSnap.docs.map((d) => {
      const data = asDoc<import("@/lib/model").UserAuditEventDoc>(d);
      return {
        ...data,
        id: d.id,
        at: toDateRequired(data.at),
        subject: { displayName: data.subjectName },
        actorUser: { displayName: data.actorName },
      };
    }),
  };
}
