import "server-only";

import { requirePermission, requireUser } from "@/lib/server/auth";
import {
  analysisStatus,
  measurementResult,
  missingCertificates,
  travellerProgress,
} from "@/lib/domain/inspection";
import { PART_STAGES, STAGE_DEFS, STATUSES, type Stage } from "@/lib/domain/stages";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "@/lib/server/firestore";
import {
  analysesOf,
  eventsOf,
  inspections,
  lots,
  materials,
  parts,
  stats,
  suppliers,
  toDate,
  toDateRequired,
  users,
  userAuditEvents,
  type AnalysisDoc,
  type InspectionDoc,
  type LotDoc,
  type MaterialDoc,
  type PartDoc,
  type PartEventDoc,
  type SupplierDoc,
  type UserAuditEventDoc,
  type UserDoc,
} from "@/lib/server/model";

/** Every function below opens with a guard.
 *
 *  `proxy.ts` is an optimistic filter — it looks at whether a session cookie
 *  exists, not at whether it is genuine — so a forged cookie gets past it. The
 *  guard belongs next to the data, where it also covers any page written later
 *  without anyone having to remember to add it. A signed-out caller is
 *  redirected rather than shown an error, so the check costs nothing in
 *  usability.
 *
 *  It is memoised for the render pass, so a page calling two of these still
 *  resolves the session once.
 *
 *  ## Reading without reading everything
 *
 *  Firestore charges per document, so a report that scans every inspection
 *  costs one read per inspection every time somebody opens it. After a year of
 *  production that is tens of thousands of reads for one page view, and the
 *  free daily allowance is gone before lunch.
 *
 *  Two techniques keep that from happening, and they are chosen per question:
 *
 *  - **Aggregation queries** (`count()`) answer "how many", billed at one read
 *    per thousand index entries matched. They are exact and cannot drift, so
 *    they are the first choice wherever the question is a count.
 *  - **A maintained counter** in `stats/failures` answers the one question
 *    aggregation cannot: which checklist line fails most often. It is written
 *    inside the same transaction as the inspection it counts, so it cannot
 *    drift either.
 */

// ───────────────────────── hydration helpers ─────────────────────────

/** Fetch many documents by id in one round trip, skipping the ones that are
 *  already known. `getAll` with no ids throws, hence the early return. */
async function getManyMaterials(ids: readonly string[]): Promise<Map<string, MaterialDoc>> {
  const wanted = [...new Set(ids.filter((id) => id))];
  if (wanted.length === 0) return new Map();

  const snapshots = await db().getAll(...wanted.map((id) => materials().doc(id)));
  const out = new Map<string, MaterialDoc>();
  for (const snap of snapshots) if (snap.exists) out.set(snap.id, snap.data() as MaterialDoc);
  return out;
}

async function getManySuppliers(ids: readonly (string | null)[]): Promise<Map<string, SupplierDoc>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();

  const snapshots = await db().getAll(...wanted.map((id) => suppliers().doc(id)));
  const out = new Map<string, SupplierDoc>();
  for (const snap of snapshots) if (snap.exists) out.set(snap.id, snap.data() as SupplierDoc);
  return out;
}

/** Stand-in for a material reference that does not resolve.
 *
 *  A lot and a part always point at one, so a miss means the data is damaged.
 *  The pages treat the relation as always present — it was a non-nullable
 *  foreign key until Firestore stopped enforcing it — so rather than make
 *  every page handle a null, a broken reference renders as a dash and is
 *  visible to whoever is looking at the row. Failing a whole queue screen
 *  because one traveller lost its spec would be the worse trade on a shop
 *  floor.
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
  createdAt: Timestamp.fromMillis(0),
  features: [],
  lotCount: 0,
  partCount: 0,
};

/** The shape the pages expect of a material: dates, not Timestamps. */
function readMaterial(id: string, doc: MaterialDoc | undefined) {
  if (!doc) return readMaterialDoc(id, MISSING_MATERIAL);
  return readMaterialDoc(id, doc);
}

function readMaterialDoc(id: string, doc: MaterialDoc) {
  return {
    ...doc,
    id,
    createdAt: toDateRequired(doc.createdAt),
    features: [...(doc.features ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    _count: { lots: doc.lotCount ?? 0, parts: doc.partCount ?? 0 },
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

/** How many documents match, without reading them. */
async function countWhere(
  collection: FirebaseFirestore.Query,
): Promise<number> {
  const snapshot = await collection.count().get();
  return snapshot.data().count;
}

// ───────────────────────── dashboard ─────────────────────────

/** Everything the dashboard shows.
 *
 *  The counts come from aggregation queries rather than from reading the
 *  documents: the dashboard is the most-opened page in the plant and reading
 *  every part on every load is exactly the pattern that empties a daily read
 *  allowance. Lots are read in full because there are few of them and the
 *  "needs attention" list has to look at each one's certificates.
 */
export async function getDashboard() {
  await requireUser();

  const [lotSnapshot, recentSnapshot, partCounts, queueCounts] = await Promise.all([
    lots().orderBy("receivedAt", "desc").get(),
    inspections().orderBy("inspectedAt", "desc").limit(12).get(),
    (async () => {
      const statuses = ["IN_PROCESS", "REWORK", "HOLD", "RELEASED", "REJECTED"] as const;
      const [total, ...byStatus] = await Promise.all([
        countWhere(parts()),
        ...statuses.map((s) => countWhere(parts().where("status", "==", s))),
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
    (async () =>
      Promise.all(
        PART_STAGES.map(async (stage) => {
          const [waiting, onHold] = await Promise.all([
            countWhere(
              parts()
                .where("currentStage", "==", stage)
                .where("status", "in", ["IN_PROCESS", "REWORK"])
            ),
            countWhere(
              parts().where("currentStage", "==", stage).where("status", "==", "HOLD")
            ),
          ]);
          return { stage, waiting, onHold };
        })
      ))(),
  ]);

  const lotRows = lotSnapshot.docs.map((d) => readLotBase(d.id, d.data() as LotDoc));
  const materialsById = await getManyMaterials(lotRows.map((l) => l.materialId));

  const lotCounts = {
    total: lotRows.length,
    pending: lotRows.filter((l) => l.status === "PENDING").length,
    accepted: lotRows.filter((l) => l.status === "ACCEPTED").length,
    rejected: lotRows.filter((l) => l.status === "REJECTED").length,
  };

  // Lots that cleared receiving but whose paperwork or analysis is unfinished.
  // The analysis state is read from the counts kept on the lot, so this does
  // not open every analysis of every lot to answer one yes-or-no question.
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
    const doc = d.data() as InspectionDoc;
    return {
      ...readInspection(d.id, doc),
      // The pages read `part.serialNumber` / `lot.lotNumber`; both are already
      // copied onto the inspection as `subject`, so nothing is fetched here.
      part: doc.partId ? { serialNumber: doc.subject } : null,
      lot: doc.lotId ? { lotNumber: doc.subject } : null,
    };
  });

  const closed = partCounts.released + partCounts.rejected;
  const firstPassYield = closed > 0 ? partCounts.released / closed : null;

  return {
    lotCounts,
    partCounts,
    queues: queueCounts,
    blocked,
    inspections: recent,
    firstPassYield,
  };
}

// ───────────────────────── lots ─────────────────────────

export async function getLots() {
  await requireUser();

  const snapshot = await lots().orderBy("receivedAt", "desc").get();
  const rows = snapshot.docs.map((d) => readLotBase(d.id, d.data() as LotDoc));

  const [materialsById, suppliersById] = await Promise.all([
    getManyMaterials(rows.map((l) => l.materialId)),
    getManySuppliers(rows.map((l) => l.supplierId)),
  ]);

  // The list shows each lot's analyses only as "is anything rejected", which
  // the counts on the lot already answer.
  return rows.map((lot) => {
    const material = readMaterial(lot.materialId, materialsById.get(lot.materialId));
    const counts = lot.analysisCounts ?? { total: 0, pending: 0, accepted: 0, rejected: 0 };
    return {
      ...lot,
      material,
      supplier: lot.supplierId
        ? (() => {
            const s = suppliersById.get(lot.supplierId);
            return s ? readSupplier(lot.supplierId, s) : null;
          })()
        : null,
      analyses: Array.from({ length: counts.rejected }, () => ({ status: "REJECTED" })).concat(
        Array.from({ length: counts.pending }, () => ({ status: "PENDING" })),
        Array.from({ length: counts.accepted }, () => ({ status: "ACCEPTED" }))
      ),
      missingCerts: missingCertificates(material.requiredCerts, lot.certificates),
    };
  });
}

export async function getLot(id: string) {
  await requireUser();

  const snapshot = await lots().doc(id).get();
  if (!snapshot.exists) return null;
  const lot = readLotBase(snapshot.id, snapshot.data() as LotDoc);

  const [materialSnap, supplierSnap, analysisSnap, inspectionSnap, partSnap] = await Promise.all([
    materials().doc(lot.materialId).get(),
    lot.supplierId ? suppliers().doc(lot.supplierId).get() : Promise.resolve(null),
    analysesOf(id).orderBy("performedAt", "desc").get(),
    inspections().where("lotId", "==", id).orderBy("inspectedAt", "desc").get(),
    parts().where("lotId", "==", id).orderBy("serialNumber", "asc").get(),
  ]);

  const material = readMaterial(
    lot.materialId,
    materialSnap.exists ? (materialSnap.data() as MaterialDoc) : undefined
  );

  return {
    ...lot,
    material,
    supplier:
      supplierSnap && supplierSnap.exists
        ? readSupplier(supplierSnap.id, supplierSnap.data() as SupplierDoc)
        : null,
    analyses: analysisSnap.docs.map((d) => readAnalysis(d.id, d.data() as AnalysisDoc)),
    inspections: inspectionSnap.docs.map((d) => readInspection(d.id, d.data() as InspectionDoc)),
    parts: partSnap.docs.map((d) => readPartBase(d.id, d.data() as PartDoc)),
    missingCerts: missingCertificates(material.requiredCerts, lot.certificates),
  };
}

// ───────────────────────── parts ─────────────────────────

export async function getParts(filter?: { stage?: Stage; status?: string }) {
  await requireUser();

  let query: FirebaseFirestore.Query = parts();
  if (filter?.stage) query = query.where("currentStage", "==", filter.stage);
  if (filter?.status) query = query.where("status", "==", filter.status);

  const snapshot = await query.orderBy("serialNumber", "asc").get();
  const rows = snapshot.docs.map((d) => readPartBase(d.id, d.data() as PartDoc));

  const [materialsById, lotNumbers, latestByPart] = await Promise.all([
    getManyMaterials(rows.map((p) => p.materialId)),
    getManyLotNumbers(rows.map((p) => p.lotId)),
    latestInspectionPerPart(rows.map((p) => p.id)),
  ]);

  return rows
    .map((part) => {
      const material = materialsById.get(part.materialId);
      const latest = latestByPart.get(part.id);
      return {
        ...part,
        material: readMaterial(part.materialId, material),
        lot: part.lotId ? { lotNumber: lotNumbers.get(part.lotId) ?? null } : null,
        inspections: latest ? [latest] : [],
        progress: travellerProgress(part),
      };
    })
    .sort((a, b) => a.status.localeCompare(b.status) || a.serialNumber.localeCompare(b.serialNumber));
}

async function getManyLotNumbers(ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return new Map();

  const snapshots = await db().getAll(...wanted.map((id) => lots().doc(id)));
  const out = new Map<string, string>();
  for (const snap of snapshots)
    if (snap.exists) out.set(snap.id, (snap.data() as LotDoc).lotNumber);
  return out;
}

/** The most recent inspection for each of these parts.
 *
 *  Asked per part, this would be one query per row. Instead it is one query
 *  per batch of thirty ids — Firestore's `in` ceiling — and the newest per
 *  part is picked out here. The list shows only the latest, so the query is
 *  bounded by taking the most recent inspections overall for those parts.
 */
async function latestInspectionPerPart(
  partIds: readonly string[]
): Promise<Map<string, ReturnType<typeof readInspection>>> {
  const out = new Map<string, ReturnType<typeof readInspection>>();
  if (partIds.length === 0) return out;

  const batches: string[][] = [];
  for (let i = 0; i < partIds.length; i += 30) batches.push(partIds.slice(i, i + 30));

  const results = await Promise.all(
    batches.map((batch) =>
      inspections()
        .where("partId", "in", batch)
        .orderBy("inspectedAt", "desc")
        .get()
    )
  );

  for (const snapshot of results)
    for (const doc of snapshot.docs) {
      const data = doc.data() as InspectionDoc;
      if (!data.partId || out.has(data.partId)) continue; // ordered newest first
      out.set(data.partId, readInspection(doc.id, data));
    }

  return out;
}

export async function getPart(id: string) {
  await requireUser();

  const snapshot = await parts().doc(id).get();
  if (!snapshot.exists) return null;
  const part = readPartBase(snapshot.id, snapshot.data() as PartDoc);

  const [materialSnap, lotSnap, eventSnap, inspectionSnap] = await Promise.all([
    materials().doc(part.materialId).get(),
    part.lotId ? lots().doc(part.lotId).get() : Promise.resolve(null),
    eventsOf(id).orderBy("at", "desc").get(),
    inspections().where("partId", "==", id).orderBy("inspectedAt", "desc").get(),
  ]);

  const lotDoc = lotSnap && lotSnap.exists ? (lotSnap.data() as LotDoc) : null;
  const supplierSnap =
    lotDoc?.supplierId != null ? await suppliers().doc(lotDoc.supplierId).get() : null;

  return {
    ...part,
    material: readMaterial(
      part.materialId,
      materialSnap.exists ? (materialSnap.data() as MaterialDoc) : undefined
    ),
    lot:
      lotSnap && lotDoc
        ? {
            ...readLotBase(lotSnap.id, lotDoc),
            supplier:
              supplierSnap && supplierSnap.exists
                ? readSupplier(supplierSnap.id, supplierSnap.data() as SupplierDoc)
                : null,
          }
        : null,
    events: eventSnap.docs.map((d) => {
      const doc = d.data() as PartEventDoc;
      return { ...doc, id: d.id, at: toDateRequired(doc.at) };
    }),
    inspections: inspectionSnap.docs.map((d) => readInspection(d.id, d.data() as InspectionDoc)),
    progress: travellerProgress(part),
  };
}

/** Parts standing in each part-stage queue, waiting to be inspected. */
export async function getQueues() {
  await requireUser();

  const snapshot = await parts()
    .where("status", "in", ["IN_PROCESS", "REWORK", "HOLD"])
    .orderBy("serialNumber", "asc")
    .get();

  const rows = snapshot.docs.map((d) => readPartBase(d.id, d.data() as PartDoc));
  const [materialsById, lotNumbers] = await Promise.all([
    getManyMaterials(rows.map((p) => p.materialId)),
    getManyLotNumbers(rows.map((p) => p.lotId)),
  ]);

  const hydrated = rows.map((part) => {
    const material = materialsById.get(part.materialId);
    return {
      ...part,
      material: readMaterial(part.materialId, material),
      lot: part.lotId ? { lotNumber: lotNumbers.get(part.lotId) ?? null } : null,
    };
  });

  return PART_STAGES.map((stage) => ({
    stage,
    def: STAGE_DEFS.find((d) => d.stage === stage)!,
    parts: hydrated.filter((p) => p.currentStage === stage),
  }));
}

// ───────────────────────── catalog ─────────────────────────

export async function getMaterials() {
  await requireUser();

  const snapshot = await materials().orderBy("partNumber", "asc").get();
  return snapshot.docs.map((d) => readMaterial(d.id, d.data() as MaterialDoc));
}

export async function getMaterial(id: string) {
  await requireUser();

  const snapshot = await materials().doc(id).get();
  if (!snapshot.exists) return null;

  const material = readMaterial(snapshot.id, snapshot.data() as MaterialDoc);
  return {
    ...material,
    features: [...material.features].sort(
      (a, b) => a.stage.localeCompare(b.stage) || a.sortOrder - b.sortOrder
    ),
  };
}

export async function getSuppliers() {
  await requireUser();

  const snapshot = await suppliers().orderBy("name", "asc").get();
  return snapshot.docs.map((d) => readSupplier(d.id, d.data() as SupplierDoc));
}

// ───────────────────────── reports ─────────────────────────

/** Rejection and rework analysis.
 *
 *  Deliberately does not read every inspection. The per-stage tallies are
 *  aggregation queries, the failing-checklist tally is the counter kept in
 *  `stats/failures`, and the out-of-tolerance list asks only for the
 *  inspections flagged as carrying one. What this page costs therefore stays
 *  flat as the plant's history grows, which is the difference between a report
 *  somebody opens freely and one that empties the day's read allowance.
 */
export async function getQualityReport() {
  await requireUser();

  const [byStage, total, failuresSnap, outOfToleranceSnap, releasedSnap] = await Promise.all([
    Promise.all(
      STAGE_DEFS.map(async (def) => {
        const forStage = () => inspections().where("stage", "==", def.stage);
        const [totalRows, ...perStatus] = await Promise.all([
          countWhere(forStage()),
          ...STATUSES.map((s) => countWhere(forStage().where("status", "==", s))),
        ]);

        const counts = Object.fromEntries(
          STATUSES.map((s, i) => [s, perStatus[i]])
        ) as Record<(typeof STATUSES)[number], number>;

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
    countWhere(inspections()),
    stats().doc("failures").get(),
    inspections()
      .where("hasFailedMeasurement", "==", true)
      .orderBy("inspectedAt", "desc")
      .limit(50)
      .get(),
    parts().where("status", "==", "RELEASED").orderBy("updatedAt", "desc").limit(200).get(),
  ]);

  // Which checklist lines actually fail, most-frequent first — the whole point
  // of keeping every answer rather than a single verdict.
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
      const doc = d.data() as InspectionDoc;
      return (doc.measurements ?? [])
        .filter((m) => measurementResult(m) === "FAIL")
        .map((m) => ({
          measurement: m,
          stage: doc.stage,
          inspectedAt: toDateRequired(doc.inspectedAt),
          subject: doc.subject || "—",
          partNumber: doc.partNumber || "—",
        }));
    })
    .slice(0, 50);

  const releasedRows = releasedSnap.docs.map((d) => readPartBase(d.id, d.data() as PartDoc));
  const [releasedMaterials, releasedLots] = await Promise.all([
    getManyMaterials(releasedRows.map((p) => p.materialId)),
    getManyLotNumbers(releasedRows.map((p) => p.lotId)),
  ]);

  const released = releasedRows.map((part) => {
    const material = releasedMaterials.get(part.materialId);
    return {
      ...part,
      material: readMaterial(part.materialId, material),
      lot: part.lotId ? { lotNumber: releasedLots.get(part.lotId) ?? null } : null,
    };
  });

  return { byStage, topFailures, outOfTolerance, released, total };
}

/** Every inspection, for the CSV export.
 *
 *  This one genuinely does read them all, because exporting the history is
 *  exactly what it is for. It is a deliberate, occasional action by one person
 *  rather than a page the plant leaves open, which is why the report above
 *  goes to the trouble of avoiding it and this does not.
 */
export async function getAllInspectionsForExport() {
  await requireUser();

  const snapshot = await inspections().orderBy("inspectedAt", "desc").get();
  return snapshot.docs.map((d) => readInspection(d.id, d.data() as InspectionDoc));
}

/** Re-derive an analysis verdict from its readings (used after an edit). */
export async function recomputeAnalysisStatus(lotId: string, analysisId: string) {
  await requireUser();

  const ref = analysesOf(lotId).doc(analysisId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return;

  const analysis = snapshot.data() as AnalysisDoc;
  await ref.update({ status: analysisStatus(analysis.results ?? []) });
}

// ───────────────────────── administration ─────────────────────────

/** Accounts and the recent history of who changed whose access.
 *
 *  Gated harder than the rest of this file: an ordinary signed-in caller has
 *  no business reading the staff list, so this asks for `user.manage` rather
 *  than merely a session.
 */
export async function getUsers() {
  const auth = await requirePermission("user.manage");
  if (!auth.ok) throw new Error(auth.error);

  const [userSnap, eventSnap] = await Promise.all([
    users().orderBy("displayName", "asc").get(),
    userAuditEvents().orderBy("at", "desc").limit(50).get(),
  ]);

  const userRows = userSnap.docs
    .map((d) => {
      const doc = d.data() as UserDoc;
      return {
        ...doc,
        id: d.id,
        createdAt: toDateRequired(doc.createdAt),
        updatedAt: toDateRequired(doc.updatedAt),
        createdBy: doc.createdByName ? { displayName: doc.createdByName } : null,
        _count: { inspections: doc.signedInspections ?? 0 },
      };
    })
    // Active first, then by name — Firestore will not order on two fields
    // without a composite index, and the staff list is small enough that
    // sorting it here is cheaper than carrying an index for it.
    .sort(
      (a, b) =>
        Number(b.active) - Number(a.active) || a.displayName.localeCompare(b.displayName)
    );

  const events = eventSnap.docs.map((d) => {
    const doc = d.data() as UserAuditEventDoc;
    return {
      ...doc,
      id: d.id,
      at: toDateRequired(doc.at),
      subject: { displayName: doc.subjectName },
      actorUser: { displayName: doc.actorName },
    };
  });

  return { users: userRows, events };
}
