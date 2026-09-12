"use client";

import {
  documentId,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
  type DocumentData,
  type Query,
  type QueryDocumentSnapshot,
} from "firebase/firestore";

import {
  analysisStatus,
  measurementResult,
  missingCertificates,
  rollup,
  travellerProgress,
} from "@/lib/domain/inspection";
import { PART_STAGES, STAGE_DEFS, STATUSES, type Stage } from "@/lib/domain/stages";
import {
  toDate,
  toDateRequired,
  type AnalysisDoc,
  type InspectionDoc,
  type LotDoc,
  type MaterialDoc,
  type PartDoc,
  type PartEventDoc,
  type SupplierDoc,
  type UserAuditEventDoc,
  type UserDoc,
} from "@/lib/model";
import {
  analysesOf,
  docIn,
  eventsOf,
  inspections,
  lots,
  materials,
  parts,
  stats,
  suppliers,
  userAuditEvents,
  users,
} from "@/lib/client/db";

/** Reading the quality data, from the browser.
 *
 *  There are no permission checks in this file, and that is not an oversight.
 *  The application is static files: any check written here would run on the
 *  caller's own machine and could be edited out of the bundle. `firestore.rules`
 *  is the boundary, it runs on Google's side, and a read it refuses throws
 *  here rather than returning empty — which is what the pages surface.
 *
 *  ## Reading without reading everything
 *
 *  Firestore charges per document, and the free daily allowance is the budget
 *  this plant is running on. A report that scans every inspection costs one
 *  read per inspection every time somebody opens it, so after a year of
 *  production one page view would empty the day.
 *
 *  Two techniques avoid that, chosen per question. Aggregation queries answer
 *  "how many", billed per thousand index entries matched rather than per
 *  document, and they cannot drift because they are computed from the index.
 *  A maintained counter in `stats/failures` answers the one question
 *  aggregation cannot — which checklist line fails most often — and is written
 *  alongside the inspection that caused it.
 */

// ───────────────────────── plumbing ─────────────────────────

/** Firestore's `in` takes at most thirty values, so lookups by id are batched
 *  into that. The Web SDK has no `getAll`, and one query per thirty documents
 *  beats one request per document by a wide margin on a shop-floor tablet. */
async function byIds<T>(
  ref: ReturnType<typeof materials>,
  ids: readonly (string | null | undefined)[]
): Promise<Map<string, T>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const out = new Map<string, T>();
  if (wanted.length === 0) return out;

  const batches: string[][] = [];
  for (let i = 0; i < wanted.length; i += 30) batches.push(wanted.slice(i, i + 30));

  const results = await Promise.all(
    batches.map((batch) => getDocs(query(ref, where(documentId(), "in", batch))))
  );
  for (const snapshot of results)
    for (const document of snapshot.docs) out.set(document.id, document.data() as T);

  return out;
}

async function countOf(q: Query<DocumentData>): Promise<number> {
  return (await getCountFromServer(q)).data().count;
}

// ───────────────────────── read models ─────────────────────────

/** Stand-in for a material reference that does not resolve.
 *
 *  A lot and a part always point at one, so a miss means the data is damaged.
 *  The pages treat the relation as always present, so a broken reference
 *  renders as a dash and is visible to whoever is looking at the row. Failing
 *  a whole queue screen because one traveller lost its spec would be the worse
 *  trade on a shop floor.
 */
const MISSING_MATERIAL: MaterialDoc = {
  partNumber: "—",
  materialNumber: null,
  description: null,
  spec: null,
  drawingNumber: null,
  drawingRev: null,
  hardnessMin: null,
  hardnessMax: null,
  hardnessUnit: "HRC",
  surfaceFinishRa: null,
  requiredCerts: null,
  roughingAllowance: null,
  createdAt: { toDate: () => new Date(0), seconds: 0, nanoseconds: 0 },
  features: [],
  lotCount: 0,
  partCount: 0,
};

function readMaterial(id: string, doc: MaterialDoc | undefined) {
  const data = doc ?? MISSING_MATERIAL;
  return {
    ...data,
    id,
    createdAt: toDateRequired(data.createdAt),
    features: [...(data.features ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    _count: { lots: data.lotCount ?? 0, parts: data.partCount ?? 0 },
  };
}

function readSupplier(id: string, doc: SupplierDoc) {
  return { ...doc, id, createdAt: toDateRequired(doc.createdAt) };
}

function readLotBase(id: string, doc: LotDoc) {
  return {
    ...doc,
    id,
    receivedAt: toDateRequired(doc.receivedAt),
    createdAt: toDateRequired(doc.createdAt),
    certificates: (doc.certificates ?? []).map((c) => ({ ...c, issuedAt: toDate(c.issuedAt) })),
    _count: { parts: doc.partCount ?? 0 },
  };
}

function readPartBase(id: string, doc: PartDoc) {
  return {
    ...doc,
    id,
    createdAt: toDateRequired(doc.createdAt),
    updatedAt: toDateRequired(doc.updatedAt),
  };
}

function readInspection(id: string, doc: InspectionDoc) {
  return {
    ...doc,
    id,
    inspectedAt: toDateRequired(doc.inspectedAt),
    checks: doc.checks ?? [],
    measurements: [...(doc.measurements ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

function readAnalysis(id: string, doc: AnalysisDoc) {
  return {
    ...doc,
    id,
    performedAt: toDateRequired(doc.performedAt),
    results: [...(doc.results ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
  };
}

const asDoc = <T>(snapshot: QueryDocumentSnapshot<DocumentData>) => snapshot.data() as T;

/** The verdict the evidence implies, re-derived rather than trusted.
 *
 *  Used by the reconciliation report and by anything that wants to know
 *  whether a stored verdict still agrees with its own checklist. It is the
 *  same pure function the form runs before the inspector signs.
 */
export function derivedVerdict(inspection: {
  stage: string;
  checks: { key: string; ok: boolean | null }[];
  measurements: {
    kind: string;
    nominal: number | null;
    tolMinus: number;
    tolPlus: number;
    gdtLimit: number | null;
    actual: number | null;
    critical: boolean;
  }[];
  hardnessValue: number | null;
  hardnessMin: number | null;
  hardnessMax: number | null;
}): string {
  return rollup({
    stage: inspection.stage as Stage,
    checks: Object.fromEntries((inspection.checks ?? []).map((c) => [c.key, c.ok])),
    measurements: inspection.measurements ?? [],
    hardness:
      inspection.stage === "HEAT_TREATMENT"
        ? {
            value: inspection.hardnessValue,
            min: inspection.hardnessMin,
            max: inspection.hardnessMax,
          }
        : undefined,
  }).suggested;
}

// ───────────────────────── dashboard ─────────────────────────

export async function getDashboard() {
  const [lotSnapshot, recentSnapshot, partCounts, queues] = await Promise.all([
    getDocs(query(lots(), orderBy("receivedAt", "desc"))),
    getDocs(query(inspections(), orderBy("inspectedAt", "desc"), limit(12))),
    (async () => {
      const statuses = ["IN_PROCESS", "REWORK", "HOLD", "RELEASED", "REJECTED"] as const;
      const [total, ...byStatus] = await Promise.all([
        countOf(query(parts())),
        ...statuses.map((s) => countOf(query(parts(), where("status", "==", s)))),
      ]);
      return {
        total,
        inProcess: byStatus[0],
        rework: byStatus[1],
        hold: byStatus[2],
        released: byStatus[3],
        rejected: byStatus[4],
      };
    })(),
    Promise.all(
      PART_STAGES.map(async (stage) => {
        const [waiting, onHold] = await Promise.all([
          countOf(
            query(
              parts(),
              where("currentStage", "==", stage),
              where("status", "in", ["IN_PROCESS", "REWORK"])
            )
          ),
          countOf(
            query(parts(), where("currentStage", "==", stage), where("status", "==", "HOLD"))
          ),
        ]);
        return { stage, waiting, onHold };
      })
    ),
  ]);

  const lotRows = lotSnapshot.docs.map((d) => readLotBase(d.id, asDoc<LotDoc>(d)));
  const materialsById = await byIds<MaterialDoc>(
    materials(),
    lotRows.map((l) => l.materialId)
  );

  const lotCounts = {
    total: lotRows.length,
    pending: lotRows.filter((l) => l.status === "PENDING").length,
    accepted: lotRows.filter((l) => l.status === "ACCEPTED").length,
    rejected: lotRows.filter((l) => l.status === "REJECTED").length,
  };

  // Lots that cleared receiving but whose paperwork or analysis is unfinished.
  // The analysis state comes from the counts kept on the lot, so this does not
  // open every analysis of every lot to answer one yes-or-no question.
  const blocked = lotRows
    .map((lot) => {
      const material = readMaterial(lot.materialId, materialsById.get(lot.materialId));
      const counts = lot.analysisCounts ?? { total: 0, pending: 0, accepted: 0, rejected: 0 };
      return {
        lot: { ...lot, material },
        missingCerts: missingCertificates(material.requiredCerts, lot.certificates),
        analysisPending: counts.total > 0 && counts.pending === counts.total,
        analysisRejected: counts.rejected > 0,
      };
    })
    .filter(
      (r) =>
        r.lot.status !== "REJECTED" &&
        (r.missingCerts.length > 0 || r.analysisPending || r.analysisRejected)
    );

  const recent = recentSnapshot.docs.map((d) => {
    const data = asDoc<InspectionDoc>(d);
    return {
      ...readInspection(d.id, data),
      // The subject is already copied onto the inspection, so naming the row
      // costs no extra read.
      part: data.partId ? { serialNumber: data.subject } : null,
      lot: data.lotId ? { lotNumber: data.subject } : null,
    };
  });

  const closed = partCounts.released + partCounts.rejected;

  return {
    lotCounts,
    partCounts,
    queues,
    blocked,
    inspections: recent,
    firstPassYield: closed > 0 ? partCounts.released / closed : null,
  };
}

// ───────────────────────── lots ─────────────────────────

export async function getLots() {
  const snapshot = await getDocs(query(lots(), orderBy("receivedAt", "desc")));
  const rows = snapshot.docs.map((d) => readLotBase(d.id, asDoc<LotDoc>(d)));

  const [materialsById, suppliersById] = await Promise.all([
    byIds<MaterialDoc>(materials(), rows.map((l) => l.materialId)),
    byIds<SupplierDoc>(suppliers(), rows.map((l) => l.supplierId)),
  ]);

  return rows.map((lot) => {
    const material = readMaterial(lot.materialId, materialsById.get(lot.materialId));
    const counts = lot.analysisCounts ?? { total: 0, pending: 0, accepted: 0, rejected: 0 };
    const supplierDoc = lot.supplierId ? suppliersById.get(lot.supplierId) : undefined;

    return {
      ...lot,
      material,
      supplier: supplierDoc && lot.supplierId ? readSupplier(lot.supplierId, supplierDoc) : null,
      // The list only asks "is anything rejected", which the tally answers.
      analyses: [
        ...Array.from({ length: counts.rejected }, () => ({ status: "REJECTED" })),
        ...Array.from({ length: counts.pending }, () => ({ status: "PENDING" })),
        ...Array.from({ length: counts.accepted }, () => ({ status: "ACCEPTED" })),
      ],
      missingCerts: missingCertificates(material.requiredCerts, lot.certificates),
    };
  });
}

export async function getLot(id: string) {
  const snapshot = await getDoc(docIn(lots(), id));
  if (!snapshot.exists()) return null;
  const lot = readLotBase(snapshot.id, snapshot.data() as LotDoc);

  const [materialSnap, supplierSnap, analysisSnap, inspectionSnap, partSnap] = await Promise.all([
    getDoc(docIn(materials(), lot.materialId)),
    lot.supplierId ? getDoc(docIn(suppliers(), lot.supplierId)) : Promise.resolve(null),
    getDocs(query(analysesOf(id), orderBy("performedAt", "desc"))),
    getDocs(query(inspections(), where("lotId", "==", id), orderBy("inspectedAt", "desc"))),
    getDocs(query(parts(), where("lotId", "==", id), orderBy("serialNumber", "asc"))),
  ]);

  const material = readMaterial(
    lot.materialId,
    materialSnap.exists() ? (materialSnap.data() as MaterialDoc) : undefined
  );

  return {
    ...lot,
    material,
    supplier:
      supplierSnap?.exists() && lot.supplierId
        ? readSupplier(lot.supplierId, supplierSnap.data() as SupplierDoc)
        : null,
    analyses: analysisSnap.docs.map((d) => readAnalysis(d.id, asDoc<AnalysisDoc>(d))),
    inspections: inspectionSnap.docs.map((d) => readInspection(d.id, asDoc<InspectionDoc>(d))),
    parts: partSnap.docs.map((d) => readPartBase(d.id, asDoc<PartDoc>(d))),
    missingCerts: missingCertificates(material.requiredCerts, lot.certificates),
  };
}

// ───────────────────────── parts ─────────────────────────

export async function getParts(filter?: { stage?: Stage; status?: string }) {
  const clauses = [
    ...(filter?.stage ? [where("currentStage", "==", filter.stage)] : []),
    ...(filter?.status ? [where("status", "==", filter.status)] : []),
  ];
  const snapshot = await getDocs(query(parts(), ...clauses, orderBy("serialNumber", "asc")));
  const rows = snapshot.docs.map((d) => readPartBase(d.id, asDoc<PartDoc>(d)));

  const [materialsById, lotsById, latestByPart] = await Promise.all([
    byIds<MaterialDoc>(materials(), rows.map((p) => p.materialId)),
    byIds<LotDoc>(lots(), rows.map((p) => p.lotId)),
    latestInspectionPerPart(rows.map((p) => p.id)),
  ]);

  return rows
    .map((part) => ({
      ...part,
      material: readMaterial(part.materialId, materialsById.get(part.materialId)),
      lot: part.lotId ? { lotNumber: lotsById.get(part.lotId)?.lotNumber ?? null } : null,
      inspections: latestByPart.get(part.id) ? [latestByPart.get(part.id)!] : [],
      progress: travellerProgress(part),
    }))
    .sort(
      (a, b) =>
        a.status.localeCompare(b.status) || a.serialNumber.localeCompare(b.serialNumber)
    );
}

/** The most recent inspection for each of these parts, in one query per batch
 *  of thirty rather than one per row. */
async function latestInspectionPerPart(
  partIds: readonly string[]
): Promise<Map<string, ReturnType<typeof readInspection>>> {
  const out = new Map<string, ReturnType<typeof readInspection>>();
  if (partIds.length === 0) return out;

  const batches: string[][] = [];
  for (let i = 0; i < partIds.length; i += 30) batches.push(partIds.slice(i, i + 30));

  const results = await Promise.all(
    batches.map((batch) =>
      getDocs(
        query(inspections(), where("partId", "in", batch), orderBy("inspectedAt", "desc"))
      )
    )
  );

  for (const snapshot of results)
    for (const document of snapshot.docs) {
      const data = asDoc<InspectionDoc>(document);
      if (!data.partId || out.has(data.partId)) continue; // ordered newest first
      out.set(data.partId, readInspection(document.id, data));
    }

  return out;
}

export async function getPart(id: string) {
  const snapshot = await getDoc(docIn(parts(), id));
  if (!snapshot.exists()) return null;
  const part = readPartBase(snapshot.id, snapshot.data() as PartDoc);

  const [materialSnap, lotSnap, eventSnap, inspectionSnap] = await Promise.all([
    getDoc(docIn(materials(), part.materialId)),
    part.lotId ? getDoc(docIn(lots(), part.lotId)) : Promise.resolve(null),
    getDocs(query(eventsOf(id), orderBy("at", "desc"))),
    getDocs(query(inspections(), where("partId", "==", id), orderBy("inspectedAt", "desc"))),
  ]);

  const lotDoc = lotSnap?.exists() ? (lotSnap.data() as LotDoc) : null;
  const supplierSnap = lotDoc?.supplierId
    ? await getDoc(docIn(suppliers(), lotDoc.supplierId))
    : null;

  return {
    ...part,
    material: readMaterial(
      part.materialId,
      materialSnap.exists() ? (materialSnap.data() as MaterialDoc) : undefined
    ),
    lot:
      lotSnap && lotDoc
        ? {
            ...readLotBase(lotSnap.id, lotDoc),
            supplier:
              supplierSnap?.exists() && lotDoc.supplierId
                ? readSupplier(lotDoc.supplierId, supplierSnap.data() as SupplierDoc)
                : null,
          }
        : null,
    events: eventSnap.docs.map((d) => {
      const data = asDoc<PartEventDoc>(d);
      return { ...data, id: d.id, at: toDateRequired(data.at) };
    }),
    inspections: inspectionSnap.docs.map((d) => readInspection(d.id, asDoc<InspectionDoc>(d))),
    progress: travellerProgress(part),
  };
}

export async function getQueues() {
  const snapshot = await getDocs(
    query(
      parts(),
      where("status", "in", ["IN_PROCESS", "REWORK", "HOLD"]),
      orderBy("serialNumber", "asc")
    )
  );
  const rows = snapshot.docs.map((d) => readPartBase(d.id, asDoc<PartDoc>(d)));

  const [materialsById, lotsById] = await Promise.all([
    byIds<MaterialDoc>(materials(), rows.map((p) => p.materialId)),
    byIds<LotDoc>(lots(), rows.map((p) => p.lotId)),
  ]);

  const hydrated = rows.map((part) => ({
    ...part,
    material: readMaterial(part.materialId, materialsById.get(part.materialId)),
    lot: part.lotId ? { lotNumber: lotsById.get(part.lotId)?.lotNumber ?? null } : null,
  }));

  return PART_STAGES.map((stage) => ({
    stage,
    def: STAGE_DEFS.find((d) => d.stage === stage)!,
    parts: hydrated.filter((p) => p.currentStage === stage),
  }));
}

// ───────────────────────── catalog ─────────────────────────

export async function getMaterials() {
  const snapshot = await getDocs(query(materials(), orderBy("partNumber", "asc")));
  return snapshot.docs.map((d) => readMaterial(d.id, asDoc<MaterialDoc>(d)));
}

export async function getMaterial(id: string) {
  const snapshot = await getDoc(docIn(materials(), id));
  if (!snapshot.exists()) return null;

  const material = readMaterial(snapshot.id, snapshot.data() as MaterialDoc);
  return {
    ...material,
    features: [...material.features].sort(
      (a, b) => a.stage.localeCompare(b.stage) || a.sortOrder - b.sortOrder
    ),
  };
}

export async function getSuppliers() {
  const snapshot = await getDocs(query(suppliers(), orderBy("name", "asc")));
  return snapshot.docs.map((d) => readSupplier(d.id, asDoc<SupplierDoc>(d)));
}

// ───────────────────────── reports ─────────────────────────

export async function getQualityReport() {
  const [byStage, total, failuresSnap, outOfToleranceSnap, releasedSnap] = await Promise.all([
    Promise.all(
      STAGE_DEFS.map(async (def) => {
        const forStage = () => query(inspections(), where("stage", "==", def.stage));
        const [totalRows, ...perStatus] = await Promise.all([
          countOf(forStage()),
          ...STATUSES.map((s) => countOf(query(forStage(), where("status", "==", s)))),
        ]);

        const counts = Object.fromEntries(STATUSES.map((s, i) => [s, perStatus[i]])) as Record<
          (typeof STATUSES)[number],
          number
        >;
        const passed = counts.ACCEPTED + counts.RELEASED;
        const closed = totalRows - counts.PENDING;

        return {
          def,
          total: totalRows,
          passed,
          rework: counts.REWORK,
          rejected: counts.REJECTED,
          investigation: counts.FURTHER_INVESTIGATION,
          pending: counts.PENDING,
          passRate: closed > 0 ? passed / closed : null,
        };
      })
    ),
    countOf(query(inspections())),
    getDoc(docIn(stats(), "failures")),
    getDocs(
      query(
        inspections(),
        where("hasFailedMeasurement", "==", true),
        orderBy("inspectedAt", "desc"),
        limit(50)
      )
    ),
    getDocs(
      query(parts(), where("status", "==", "RELEASED"), orderBy("updatedAt", "desc"), limit(200))
    ),
  ]);

  const failureCounts = (failuresSnap.data()?.counts ?? {}) as Record<string, number>;
  const topFailures = Object.entries(failureCounts)
    .filter(([, count]) => count > 0)
    .map(([id, count]) => {
      const [stage, key] = id.split("::");
      return { stage, key, count };
    })
    .sort((a, b) => b.count - a.count);

  const outOfTolerance = outOfToleranceSnap.docs
    .flatMap((d) => {
      const data = asDoc<InspectionDoc>(d);
      return (data.measurements ?? [])
        .filter((m) => measurementResult(m) === "FAIL")
        .map((m) => ({
          measurement: m,
          stage: data.stage,
          inspectedAt: toDateRequired(data.inspectedAt),
          subject: data.subject || "—",
          partNumber: data.partNumber || "—",
        }));
    })
    .slice(0, 50);

  const releasedRows = releasedSnap.docs.map((d) => readPartBase(d.id, asDoc<PartDoc>(d)));
  const [releasedMaterials, releasedLots] = await Promise.all([
    byIds<MaterialDoc>(materials(), releasedRows.map((p) => p.materialId)),
    byIds<LotDoc>(lots(), releasedRows.map((p) => p.lotId)),
  ]);

  const released = releasedRows.map((part) => ({
    ...part,
    material: readMaterial(part.materialId, releasedMaterials.get(part.materialId)),
    lot: part.lotId ? { lotNumber: releasedLots.get(part.lotId)?.lotNumber ?? null } : null,
  }));

  return { byStage, topFailures, outOfTolerance, released, total };
}

/** Inspections whose stored verdict disagrees with their own evidence.
 *
 *  This is the compensating control for the one guarantee that did not survive
 *  losing the server. Security rules cannot re-derive a verdict — they cannot
 *  iterate the measurements array, let alone reproduce the tolerance
 *  arithmetic — so a tampered client can file a sheet claiming ACCEPTED over a
 *  failed critical feature.
 *
 *  What it cannot prevent, it can make impossible to hide: the answers and the
 *  measurements are stored, the rule is pure, and both are right here. Every
 *  stored verdict is re-derived and anything that does not match is listed.
 *
 *  It reads every inspection, which is why it is a report somebody opens
 *  deliberately rather than part of the dashboard.
 */
export async function getVerdictReconciliation() {
  const snapshot = await getDocs(query(inspections(), orderBy("inspectedAt", "desc")));

  const rows = snapshot.docs
    .map((d) => readInspection(d.id, asDoc<InspectionDoc>(d)))
    .map((inspection) => ({ inspection, derived: derivedVerdict(inspection) }))
    // PENDING means the sheet was left unfinished, which the evidence cannot
    // contradict — an unanswered line is not a disagreement.
    .filter(({ inspection, derived }) => inspection.status !== derived && inspection.status !== "PENDING");

  return { disagreements: rows, checked: snapshot.size };
}

/** Every inspection, for the CSV export. This one genuinely does read them
 *  all, because exporting the history is what it is for. */
export async function getAllInspectionsForExport() {
  const snapshot = await getDocs(query(inspections(), orderBy("inspectedAt", "desc")));
  return snapshot.docs.map((d) => readInspection(d.id, asDoc<InspectionDoc>(d)));
}

export async function recomputeAnalysisStatus(lotId: string, analysisId: string) {
  const ref = docIn(analysesOf(lotId), analysisId);
  const snapshot = await getDoc(ref);
  if (!snapshot.exists()) return null;
  const analysis = snapshot.data() as AnalysisDoc;
  return analysisStatus(analysis.results ?? []);
}

// ───────────────────────── administration ─────────────────────────

/** One row of the staff list, from the stored document.
 *
 *  Pulled out of `getUsers` and exported so it can be tested against the
 *  sparsest document the system ever holds: the founding administrator's,
 *  typed into the Firestore console by hand before there was an application
 *  to create it. Everything the application writes is richer than that, so a
 *  mapping that survives it survives the rest.
 */
export function toUserRow(id: string, data: UserDoc) {
  return {
    ...data,
    id,
    // Nullable, unlike every other timestamp in this file, because that
    // founding document has no creation date — see «أول حساب» in the README.
    // A staff list that will not open because of a missing date locks an
    // administrator out of the only screen that can let anybody else in.
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
    createdBy: data.createdByName ? { displayName: data.createdByName } : null,
    _count: { inspections: data.signedInspections ?? 0 },
  };
}

/** Active first, then by name. Firestore will not order on two fields without
 *  a composite index, and the staff list is small enough that sorting it here
 *  is cheaper than carrying an index for it. */
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

  const userRows = userSnap.docs
    .map((d) => toUserRow(d.id, asDoc<UserDoc>(d)))
    .sort(byActiveThenName);

  const events = eventSnap.docs.map((d) => {
    const data = asDoc<UserAuditEventDoc>(d);
    return {
      ...data,
      id: d.id,
      at: toDateRequired(data.at),
      subject: { displayName: data.subjectName },
      actorUser: { displayName: data.actorName },
    };
  });

  return { users: userRows, events };
}
