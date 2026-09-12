/** Demo data: two part numbers walked through the whole flow so every page has
 *  something real to show. Idempotent — it wipes and reloads every collection.
 *
 *  The counters the application maintains (a lot's parts, a material's lots and
 *  parts, an account's signed inspections, the per-line failure tally) are
 *  written here too, and by the same arithmetic the actions use. A seed that
 *  filled the records but not the counters would leave the dashboard and the
 *  reports quietly disagreeing with the data underneath them.
 */

import { Timestamp, type WriteBatch } from "firebase-admin/firestore";

import {
  analysisStatus,
  measurementResult,
  nextPartState,
  rollup,
  type MeasurementSpec,
} from "../lib/domain/inspection";
import { stageDef, type Stage, type Status } from "../lib/domain/stages";
import { db } from "../lib/server/firestore";
import {
  COLLECTIONS,
  analysesOf,
  eventsOf,
  inspections,
  lots,
  materials,
  newId,
  parts,
  stats,
  suppliers,
  uniqueKey,
  uniques,
  users,
  type AnalysisResultEntry,
  type CertificateEntry,
  type FeatureEntry,
  type MeasurementEntry,
} from "../lib/server/model";

const firestore = db();

function daysAgo(n: number): Timestamp {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return Timestamp.fromDate(d);
}

/** Delete every document in a collection, including its subcollections. */
async function wipe(path: string): Promise<void> {
  const snapshot = await firestore.collection(path).get();
  for (const doc of snapshot.docs) await firestore.recursiveDelete(doc.ref);
}

/** Batched writes, flushed before Firestore's five-hundred-operation ceiling.
 *
 *  Queued rather than committed as they are made, then committed in order. The
 *  queue is what keeps this a handful of round trips instead of one per
 *  document, which matters because the seed writes several hundred.
 */
class Writer {
  private queue: { ref: FirebaseFirestore.DocumentReference; data: FirebaseFirestore.DocumentData; merge: boolean }[] = [];

  set(
    ref: FirebaseFirestore.DocumentReference,
    data: FirebaseFirestore.DocumentData,
    options: { merge?: boolean } = {}
  ): void {
    this.queue.push({ ref, data, merge: options.merge ?? false });
  }

  async flush(): Promise<void> {
    for (let i = 0; i < this.queue.length; i += 400) {
      const batch: WriteBatch = firestore.batch();
      for (const write of this.queue.slice(i, i + 400))
        batch.set(write.ref, write.data, { merge: write.merge });
      await batch.commit();
    }
    this.queue = [];
  }
}

/** Reserve a value the way the application does, so the seeded data is subject
 *  to the same uniqueness guarantee as anything typed in later. */
function reserve(
  writer: Writer,
  scope: Parameters<typeof uniqueKey>[0],
  value: string,
  ownerPath: string
): void {
  writer.set(uniques().doc(uniqueKey(scope, value)), {
    scope,
    value,
    ownerPath,
    at: Timestamp.now(),
  });
}

async function main() {
  for (const path of Object.values(COLLECTIONS)) await wipe(path);

  const writer = new Writer();
  const failureTally = new Map<string, number>();
  const signedByUid = new Map<string, number>();

  const recordChecks = (stage: Stage, checks: { key: string; ok: boolean | null }[]) => {
    for (const check of checks)
      if (check.ok === false) {
        const id = `${stage}::${check.key}`;
        failureTally.set(id, (failureTally.get(id) ?? 0) + 1);
      }
  };

  // ── the people the demo history is signed by ──
  //
  // Seeded inactive and with synthetic uids on purpose: this is historical
  // data, not a set of accounts anyone can sign in with. Create the real first
  // account with `npm run create-admin`.
  const STAFF = [
    { displayName: "Hala Fouad", email: "hala@example.invalid", role: "INSPECTOR" },
    { displayName: "Karim Adel", email: "karim@example.invalid", role: "INSPECTOR" },
    { displayName: "Ahmed Salem", email: "ahmed@example.invalid", role: "INSPECTOR" },
    { displayName: "Tarek Selim", email: "tarek@example.invalid", role: "SUPERVISOR" },
    { displayName: "Mona Rashad", email: "mona@example.invalid", role: "QUALITY_MANAGER" },
  ] as const;

  const staffUid = new Map<string, string>();
  for (const person of STAFF) {
    const uid = `seed-${person.email.split("@")[0]}`;
    staffUid.set(person.displayName, uid);
    reserve(writer, "user.email", person.email, users().doc(uid).path);
    writer.set(users().doc(uid), {
      email: person.email,
      displayName: person.displayName,
      role: person.role,
      employeeNo: null,
      active: false,
      createdAt: daysAgo(60),
      updatedAt: daysAgo(60),
      createdByUid: null,
      createdByName: null,
      signedInspections: 0,
    });
  }

  /** The uid behind a demo inspector's name. Throws rather than guessing: a
   *  typo would otherwise seed a record signed by nobody. */
  const uid = (name: string): string => {
    const found = staffUid.get(name);
    if (!found) throw new Error(`seed: unknown inspector "${name}"`);
    return found;
  };

  const signedBy = (name: string) => {
    const id = uid(name);
    signedByUid.set(id, (signedByUid.get(id) ?? 0) + 1);
    return id;
  };

  // ── suppliers ──
  const bohlerId = newId();
  const dorrenbergId = newId();
  for (const [id, name, code, contact] of [
    [bohlerId, "Böhler Edelstahl", "BOH", "sales@bohler.example"],
    [dorrenbergId, "Dörrenberg Edelstahl", "DOR", "info@dorrenberg.example"],
  ] as const) {
    reserve(writer, "supplier.name", name, suppliers().doc(id).path);
    writer.set(suppliers().doc(id), {
      name,
      code,
      contact,
      notes: null,
      createdAt: daysAgo(60),
    });
  }

  // ── material 1: a hardened die punch ──
  const feature = (f: Partial<FeatureEntry> & { stage: string; name: string; sortOrder: number }): FeatureEntry => ({
    id: newId(),
    kind: "DIMENSION",
    nominal: null,
    tolMinus: 0,
    tolPlus: 0,
    unit: "mm",
    critical: false,
    gdtSymbol: null,
    gdtLimit: null,
    ...f,
  });

  const punchFeatures: FeatureEntry[] = [
    feature({ stage: "POST_ROUGHING", name: "Outside diameter (rough)", nominal: 50.6, tolMinus: 0.2, tolPlus: 0.2, sortOrder: 1 }),
    feature({ stage: "POST_ROUGHING", name: "Overall length (rough)", nominal: 120.5, tolMinus: 0.3, tolPlus: 0.3, sortOrder: 2 }),
    feature({ stage: "POST_GRINDING", name: "Outside diameter", nominal: 50.02, tolMinus: 0.01, tolPlus: 0.01, critical: true, sortOrder: 1 }),
    feature({ stage: "POST_GRINDING", name: "Overall length", nominal: 120, tolMinus: 0.05, tolPlus: 0.05, sortOrder: 2 }),
    feature({ stage: "FINAL", name: "Outside diameter (final)", nominal: 50, tolMinus: 0.005, tolPlus: 0.005, critical: true, sortOrder: 1 }),
    feature({ stage: "FINAL", name: "Overall length (final)", nominal: 120, tolMinus: 0.02, tolPlus: 0.02, sortOrder: 2 }),
    feature({ stage: "FINAL", name: "Runout A-B", kind: "GDT", gdtSymbol: "⌭", gdtLimit: 0.02, critical: true, sortOrder: 3 }),
    feature({ stage: "FINAL", name: "Perpendicularity", kind: "GDT", gdtSymbol: "⊥", gdtLimit: 0.03, sortOrder: 4 }),
  ];

  const punchId = newId();
  const punch = {
    partNumber: "PN-1042-A",
    materialNumber: "1.2379",
    description: "Die punch — cold work tool steel",
    spec: "DIN 1.2379 / AISI D2",
    drawingNumber: "DRW-1042",
    drawingRev: "B",
    hardnessMin: 58,
    hardnessMax: 62,
    hardnessUnit: "HRC",
    surfaceFinishRa: 0.4,
    requiredCerts: "Mill Test Certificate, Heat Treatment Certificate",
    roughingAllowance: 0.5,
  };
  reserve(writer, "material.partNumber", punch.partNumber, materials().doc(punchId).path);
  writer.set(materials().doc(punchId), {
    ...punch,
    createdAt: daysAgo(60),
    features: punchFeatures,
    lotCount: 2,
    partCount: 10,
  });

  // ── material 2: a case-hardened shaft ──
  const shaftId = newId();
  const shaft = {
    partNumber: "PN-2210-C",
    materialNumber: "1.7131",
    description: "Drive shaft — case hardening steel",
    spec: "DIN 1.7131 / 16MnCr5",
    drawingNumber: "DRW-2210",
    drawingRev: "A",
    hardnessMin: 60,
    hardnessMax: null,
    hardnessUnit: "HRC",
    surfaceFinishRa: 0.8,
    requiredCerts: "Mill Test Certificate",
    roughingAllowance: 0.4,
  };
  reserve(writer, "material.partNumber", shaft.partNumber, materials().doc(shaftId).path);
  writer.set(materials().doc(shaftId), {
    ...shaft,
    createdAt: daysAgo(60),
    features: [
      feature({ stage: "POST_ROUGHING", name: "Bearing diameter (rough)", nominal: 35.4, tolMinus: 0.15, tolPlus: 0.15, sortOrder: 1 }),
      feature({ stage: "POST_GRINDING", name: "Bearing diameter", nominal: 35.01, tolMinus: 0.008, tolPlus: 0.008, critical: true, sortOrder: 1 }),
      feature({ stage: "FINAL", name: "Bearing diameter (final)", nominal: 35, tolMinus: 0.005, tolPlus: 0.005, critical: true, sortOrder: 1 }),
      feature({ stage: "FINAL", name: "Concentricity", kind: "GDT", gdtSymbol: "⌾", gdtLimit: 0.015, sortOrder: 2 }),
    ],
    lotCount: 1,
    partCount: 0,
  });

  // ── lots ──
  const certificate = (c: Partial<CertificateEntry> & { type: string }): CertificateEntry => ({
    id: newId(),
    number: null,
    issuedAt: null,
    received: false,
    verified: false,
    notes: null,
    ...c,
  });

  const lotAId = newId();
  const lotA = { lotNumber: "LOT-2026-001", materialId: punchId, supplierId: bohlerId };
  reserve(writer, "lot.lotNumber", lotA.lotNumber, lots().doc(lotAId).path);
  writer.set(lots().doc(lotAId), {
    ...lotA,
    receivedAt: daysAgo(21),
    poNumber: "PO-88412",
    heatNumber: "H-55210",
    receivedQty: 40,
    unit: "pcs",
    status: "ACCEPTED",
    notes: null,
    createdAt: daysAgo(21),
    certificates: [
      certificate({ type: "Mill Test Certificate", number: "MTC-55210", received: true, verified: true, issuedAt: daysAgo(25) }),
      certificate({ type: "Heat Treatment Certificate", number: "HT-9921", received: true, verified: true, issuedAt: daysAgo(24) }),
    ],
    partCount: 10,
    analysisCounts: { total: 1, pending: 0, accepted: 1, rejected: 0 },
  });

  const lotBId = newId();
  const lotB = { lotNumber: "LOT-2026-002", materialId: shaftId, supplierId: dorrenbergId };
  reserve(writer, "lot.lotNumber", lotB.lotNumber, lots().doc(lotBId).path);
  writer.set(lots().doc(lotBId), {
    ...lotB,
    receivedAt: daysAgo(9),
    poNumber: "PO-88530",
    heatNumber: "H-61044",
    receivedQty: 60,
    unit: "pcs",
    status: "PENDING",
    notes: null,
    createdAt: daysAgo(9),
    // Deliberately not received — the dashboard should flag this lot.
    certificates: [certificate({ type: "Mill Test Certificate" })],
    partCount: 0,
    analysisCounts: { total: 1, pending: 1, accepted: 0, rejected: 0 },
  });

  const lotCId = newId();
  const lotC = { lotNumber: "LOT-2026-003", materialId: punchId, supplierId: dorrenbergId };
  reserve(writer, "lot.lotNumber", lotC.lotNumber, lots().doc(lotCId).path);
  writer.set(lots().doc(lotCId), {
    ...lotC,
    receivedAt: daysAgo(4),
    poNumber: "PO-88604",
    heatNumber: "H-61190",
    receivedQty: 25,
    unit: "pcs",
    status: "REJECTED",
    notes: "Visible surface rust on 6 pieces, and the mill certificate does not match the heat number.",
    createdAt: daysAgo(4),
    certificates: [
      certificate({ type: "Mill Test Certificate", number: "MTC-61190", received: true, verified: false }),
      certificate({ type: "Heat Treatment Certificate" }),
    ],
    partCount: 0,
    analysisCounts: { total: 0, pending: 0, accepted: 0, rejected: 0 },
  });

  // ── receiving inspections ──
  function receivingInspection(
    lotId: string,
    lotNumber: string,
    partNumber: string,
    inspector: string,
    at: Timestamp,
    failedKeys: string[] = [],
    forced?: Status
  ) {
    const def = stageDef("RAW_RECEIVING");
    const checks = def.items.map((i) => ({
      key: i.key,
      ok: !failedKeys.includes(i.key),
      note: failedKeys.includes(i.key) ? "Does not conform — see notes" : null,
    }));
    const verdict =
      forced ??
      rollup({
        stage: "RAW_RECEIVING",
        checks: Object.fromEntries(checks.map((c) => [c.key, c.ok])),
      }).suggested;

    recordChecks("RAW_RECEIVING", checks);
    writer.set(inspections().doc(newId()), {
      stage: "RAW_RECEIVING",
      partId: null,
      lotId,
      inspectorUid: signedBy(inspector),
      inspector,
      inspectedAt: at,
      status: verdict,
      notes: null,
      hardnessValue: null,
      hardnessUnit: null,
      hardnessMin: null,
      hardnessMax: null,
      surfaceFinishRa: null,
      cmmRequired: false,
      cmmReportRef: null,
      cmmReviewed: false,
      checks,
      measurements: [],
      subject: lotNumber,
      partNumber,
      hasFailedMeasurement: false,
    });
  }

  receivingInspection(lotAId, lotA.lotNumber, punch.partNumber, "Ahmed Salem", daysAgo(21));
  receivingInspection(
    lotCId,
    lotC.lotNumber,
    punch.partNumber,
    "Ahmed Salem",
    daysAgo(4),
    ["visual_inspection", "review_certificates"],
    "REJECTED"
  );

  // ── analyses ──
  const result = (r: Partial<AnalysisResultEntry> & { property: string; sortOrder: number }): AnalysisResultEntry => ({
    id: newId(),
    requiredMin: null,
    requiredMax: null,
    requiredText: null,
    actual: null,
    actualText: null,
    unit: "%",
    pass: null,
    ...r,
  });

  const analysisAResults = [
    result({ property: "C %", requiredMin: 1.45, requiredMax: 1.6, actual: 1.52, sortOrder: 0 }),
    result({ property: "Cr %", requiredMin: 11, requiredMax: 12.5, actual: 11.8, sortOrder: 1 }),
    result({ property: "Mo %", requiredMin: 0.7, requiredMax: 1.0, actual: 0.82, sortOrder: 2 }),
    result({ property: "V %", requiredMin: 0.7, requiredMax: 1.0, actual: 0.9, sortOrder: 3 }),
    result({ property: "P %", requiredMax: 0.03, actual: 0.018, sortOrder: 4 }),
    result({ property: "S %", requiredMax: 0.03, actual: 0.011, sortOrder: 5 }),
  ];

  writer.set(analysesOf(lotAId).doc(newId()), {
    sampleRef: "S-001",
    method: "Spectro",
    performedAt: daysAgo(20),
    performedBy: "Materials laboratory",
    recordedByUid: uid("Mona Rashad"),
    recordedByName: "Mona Rashad",
    status: analysisStatus(analysisAResults),
    conclusion: "Conforms to DIN 1.2379.",
    actionTaken: null,
    results: analysisAResults,
  });

  // Lot B's sample is open but unread — it should read as pending everywhere.
  writer.set(analysesOf(lotBId).doc(newId()), {
    sampleRef: "S-014",
    method: "Spectro",
    performedAt: daysAgo(8),
    performedBy: "Materials laboratory",
    recordedByUid: uid("Mona Rashad"),
    recordedByName: "Mona Rashad",
    status: "PENDING",
    conclusion: null,
    actionTaken: null,
    results: [
      result({ property: "C %", requiredMin: 0.14, requiredMax: 0.19, sortOrder: 0 }),
      result({ property: "Cr %", requiredMin: 0.8, requiredMax: 1.1, sortOrder: 1 }),
      result({ property: "Mn %", requiredMin: 1.0, requiredMax: 1.3, sortOrder: 2 }),
    ],
  });

  // ── parts and their inspections ──
  interface Step {
    stage: Stage;
    inspector: string;
    at: Timestamp;
    failedKeys?: string[];
    actuals?: Record<string, number>;
    hardness?: number;
    ra?: number;
    cmmRef?: string;
  }

  /** Run one part through `plan`, recording a real inspection per stage. */
  function runPart(serialNumber: string, plan: Step[]): void {
    const partId = newId();
    reserve(writer, "part.serialNumber", serialNumber, parts().doc(partId).path);

    writer.set(eventsOf(partId).doc(newId()), {
      at: daysAgo(18),
      kind: "CREATED",
      stage: "POST_ROUGHING",
      fromValue: null,
      toValue: "POST_ROUGHING/IN_PROCESS",
      note: `Raised from lot ${lotA.lotNumber}`,
      actorUid: uid("Tarek Selim"),
      actor: "Tarek Selim",
    });

    let currentStage: Stage | "DONE" = "POST_ROUGHING";
    let status = "IN_PROCESS";

    for (const step of plan) {
      if (currentStage !== step.stage) break;
      const def = stageDef(step.stage);
      const failed = step.failedKeys ?? [];
      const checks = def.items.map((i) => ({
        key: i.key,
        ok: !failed.includes(i.key),
        note: failed.includes(i.key) ? "Does not conform" : null,
      }));

      const stageFeatures = punchFeatures.filter((f) => f.stage === step.stage);
      const specs: MeasurementSpec[] = stageFeatures.map((f) => ({
        kind: f.kind,
        nominal: f.nominal,
        tolMinus: f.tolMinus,
        tolPlus: f.tolPlus,
        gdtLimit: f.gdtLimit,
        actual: step.actuals?.[f.name] ?? null,
        critical: f.critical,
      }));
      const measurements: MeasurementEntry[] = stageFeatures.map((f, i) => ({
        featureId: f.id,
        name: f.name,
        kind: f.kind,
        nominal: f.nominal,
        tolMinus: f.tolMinus,
        tolPlus: f.tolPlus,
        gdtLimit: f.gdtLimit,
        actual: specs[i].actual ?? null,
        unit: f.unit,
        critical: f.critical,
        result: measurementResult(specs[i]),
        sortOrder: i,
      }));

      const hardness =
        step.stage === "HEAT_TREATMENT"
          ? { value: step.hardness ?? null, min: punch.hardnessMin, max: punch.hardnessMax }
          : undefined;

      const verdict = rollup({
        stage: step.stage,
        checks: Object.fromEntries(checks.map((c) => [c.key, c.ok])),
        measurements: specs,
        hardness,
      }).suggested;

      recordChecks(step.stage, checks);
      writer.set(inspections().doc(newId()), {
        stage: step.stage,
        partId,
        lotId: lotAId,
        inspectorUid: signedBy(step.inspector),
        inspector: step.inspector,
        inspectedAt: step.at,
        status: verdict,
        notes: null,
        hardnessValue: step.stage === "HEAT_TREATMENT" ? (step.hardness ?? null) : null,
        hardnessUnit: step.stage === "HEAT_TREATMENT" ? punch.hardnessUnit : null,
        hardnessMin: step.stage === "HEAT_TREATMENT" ? punch.hardnessMin : null,
        hardnessMax: step.stage === "HEAT_TREATMENT" ? punch.hardnessMax : null,
        surfaceFinishRa: step.stage === "FINAL" ? (step.ra ?? null) : null,
        cmmRequired: step.stage === "FINAL" && step.cmmRef != null,
        cmmReportRef: step.stage === "FINAL" ? (step.cmmRef ?? null) : null,
        cmmReviewed: step.stage === "FINAL" && step.cmmRef != null,
        checks,
        measurements,
        subject: serialNumber,
        partNumber: punch.partNumber,
        hasFailedMeasurement: measurements.some((m) => m.result === "FAIL"),
      });

      const transition = nextPartState(step.stage, verdict);
      writer.set(eventsOf(partId).doc(newId()), {
        at: step.at,
        kind: "INSPECTION",
        stage: step.stage,
        fromValue: `${currentStage}/${status}`,
        toValue: `${transition.stage}/${transition.status}`,
        note: `${def.ar} — ${verdict}`,
        actorUid: uid(step.inspector),
        actor: step.inspector,
      });

      currentStage = transition.stage;
      status = transition.status;
      if (status === "REJECTED" || status === "REWORK" || status === "HOLD") break;
    }

    writer.set(parts().doc(partId), {
      serialNumber,
      materialId: punchId,
      lotId: lotAId,
      batchQty: 1,
      currentStage,
      status,
      createdAt: daysAgo(18),
      updatedAt: plan.length > 0 ? plan[plan.length - 1].at : daysAgo(18),
    });
  }

  const goodActuals = {
    roughing: { "Outside diameter (rough)": 50.62, "Overall length (rough)": 120.48 },
    grinding: { "Outside diameter": 50.021, "Overall length": 120.01 },
    final: {
      "Outside diameter (final)": 50.002,
      "Overall length (final)": 120.005,
      "Runout A-B": 0.011,
      "Perpendicularity": 0.018,
    },
  };

  // Three parts released clean.
  for (let i = 1; i <= 3; i++) {
    runPart(`LOT-2026-001-${String(i).padStart(4, "0")}`, [
      { stage: "POST_ROUGHING", inspector: "Hala Fouad", at: daysAgo(17), actuals: goodActuals.roughing },
      { stage: "HEAT_TREATMENT", inspector: "Karim Adel", at: daysAgo(14), hardness: 60 + i * 0.3 },
      { stage: "POST_GRINDING", inspector: "Hala Fouad", at: daysAgo(10), actuals: goodActuals.grinding },
      {
        stage: "FINAL",
        inspector: "Mona Rashad",
        at: daysAgo(6),
        actuals: goodActuals.final,
        ra: 0.3,
        cmmRef: `CMM-2026-01${i}`,
      },
    ]);
  }

  // Rejected at final on a critical runout.
  runPart("LOT-2026-001-0004", [
    { stage: "POST_ROUGHING", inspector: "Hala Fouad", at: daysAgo(17), actuals: goodActuals.roughing },
    { stage: "HEAT_TREATMENT", inspector: "Karim Adel", at: daysAgo(14), hardness: 59.4 },
    { stage: "POST_GRINDING", inspector: "Hala Fouad", at: daysAgo(10), actuals: goodActuals.grinding },
    {
      stage: "FINAL",
      inspector: "Mona Rashad",
      at: daysAgo(5),
      actuals: { ...goodActuals.final, "Runout A-B": 0.045 },
      ra: 0.35,
      cmmRef: "CMM-2026-014",
    },
  ]);

  // Soft after heat treatment → rejected there.
  runPart("LOT-2026-001-0005", [
    { stage: "POST_ROUGHING", inspector: "Hala Fouad", at: daysAgo(17), actuals: goodActuals.roughing },
    { stage: "HEAT_TREATMENT", inspector: "Karim Adel", at: daysAgo(13), hardness: 54.5 },
  ]);

  // Over-hard → further investigation, sits on hold.
  runPart("LOT-2026-001-0006", [
    { stage: "POST_ROUGHING", inspector: "Hala Fouad", at: daysAgo(17), actuals: goodActuals.roughing },
    { stage: "HEAT_TREATMENT", inspector: "Karim Adel", at: daysAgo(13), hardness: 64.2 },
  ]);

  // Grinding burn → rework, waiting to be sent back.
  runPart("LOT-2026-001-0007", [
    { stage: "POST_ROUGHING", inspector: "Hala Fouad", at: daysAgo(17), actuals: goodActuals.roughing },
    { stage: "HEAT_TREATMENT", inspector: "Karim Adel", at: daysAgo(13), hardness: 60.1 },
    {
      stage: "POST_GRINDING",
      inspector: "Hala Fouad",
      at: daysAgo(8),
      failedKeys: ["no_grinding_burn"],
      actuals: goodActuals.grinding,
    },
  ]);

  // Three still walking the line, one per queue.
  runPart("LOT-2026-001-0008", [
    { stage: "POST_ROUGHING", inspector: "Hala Fouad", at: daysAgo(16), actuals: goodActuals.roughing },
    { stage: "HEAT_TREATMENT", inspector: "Karim Adel", at: daysAgo(11), hardness: 61 },
    { stage: "POST_GRINDING", inspector: "Hala Fouad", at: daysAgo(7), actuals: goodActuals.grinding },
  ]);
  runPart("LOT-2026-001-0009", [
    { stage: "POST_ROUGHING", inspector: "Hala Fouad", at: daysAgo(16), actuals: goodActuals.roughing },
    { stage: "HEAT_TREATMENT", inspector: "Karim Adel", at: daysAgo(11), hardness: 59.8 },
  ]);
  runPart("LOT-2026-001-0010", []);

  // ── the counters, by the same arithmetic the actions use ──
  writer.set(stats().doc("failures"), { counts: Object.fromEntries(failureTally) });
  // Merged, not replaced: the account document was queued earlier in this same
  // run and a plain set would overwrite it with a single field.
  for (const [id, count] of signedByUid)
    writer.set(users().doc(id), { signedInspections: count }, { merge: true });

  await writer.flush();

  // Counting what was actually written, rather than what we meant to write.
  const [supplierCount, materialCount, lotCount, partCount, inspectionCount] = await Promise.all([
    suppliers().count().get(),
    materials().count().get(),
    lots().count().get(),
    parts().count().get(),
    inspections().count().get(),
  ]);

  console.log("Seeded:", {
    staff: STAFF.length,
    suppliers: supplierCount.data().count,
    materials: materialCount.data().count,
    lots: lotCount.data().count,
    parts: partCount.data().count,
    inspections: inspectionCount.data().count,
    failureLines: failureTally.size,
  });
  console.log(
    `Lots: ${lotA.lotNumber} accepted · ${lotB.lotNumber} pending · ${lotC.lotNumber} rejected`
  );
  console.log(`Materials: ${punch.partNumber}, ${shaft.partNumber}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
