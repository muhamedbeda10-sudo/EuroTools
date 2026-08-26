/** Demo data: two part numbers walked through the whole flow so every page has
 *  something real to show. Idempotent — it wipes and reloads every table. */

import { PrismaClient } from "@prisma/client";

import {
  analysisStatus,
  measurementResult,
  nextPartState,
  rollup,
  type MeasurementSpec,
} from "../lib/domain/inspection";
import { stageDef, type Stage, type Status } from "../lib/domain/stages";

const prisma = new PrismaClient();

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

async function main() {
  // Order matters: children before parents.
  await prisma.measurement.deleteMany();
  await prisma.checkResult.deleteMany();
  await prisma.inspection.deleteMany();
  await prisma.partEvent.deleteMany();
  await prisma.part.deleteMany();
  await prisma.analysisResult.deleteMany();
  await prisma.analysis.deleteMany();
  await prisma.certificate.deleteMany();
  await prisma.lot.deleteMany();
  await prisma.materialFeature.deleteMany();
  await prisma.material.deleteMany();
  await prisma.supplier.deleteMany();

  // The id columns are AUTOINCREMENT, so SQLite keeps counting up across wipes
  // and every re-seed would hand out new ids — and new URLs. Reset the
  // counters so seeding twice gives exactly the same database.
  await prisma.$executeRawUnsafe("DELETE FROM sqlite_sequence");

  const [bohler, dorrenberg] = await Promise.all([
    prisma.supplier.create({
      data: { name: "Böhler Edelstahl", code: "BOH", contact: "sales@bohler.example" },
    }),
    prisma.supplier.create({
      data: { name: "Dörrenberg Edelstahl", code: "DOR", contact: "info@dorrenberg.example" },
    }),
  ]);

  // ── material 1: a hardened die punch ──
  const punch = await prisma.material.create({
    data: {
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
      roughingAllowance: 0.6,
      requiredCerts: "Mill Test Certificate, Heat Treatment Certificate",
      features: {
        create: [
          {
            stage: "POST_ROUGHING",
            name: "القطر الخارجي (rough)",
            nominal: 50.6,
            tolMinus: 0.2,
            tolPlus: 0.2,
            unit: "mm",
            sortOrder: 1,
          },
          {
            stage: "POST_ROUGHING",
            name: "الطول الكلي (rough)",
            nominal: 120.5,
            tolMinus: 0.3,
            tolPlus: 0.3,
            unit: "mm",
            sortOrder: 2,
          },
          {
            stage: "POST_GRINDING",
            name: "القطر الخارجي",
            nominal: 50.02,
            tolMinus: 0.01,
            tolPlus: 0.01,
            unit: "mm",
            critical: true,
            sortOrder: 1,
          },
          {
            stage: "POST_GRINDING",
            name: "الطول الكلي",
            nominal: 120,
            tolMinus: 0.05,
            tolPlus: 0.05,
            unit: "mm",
            sortOrder: 2,
          },
          {
            stage: "FINAL",
            name: "القطر الخارجي النهائي",
            nominal: 50,
            tolMinus: 0.005,
            tolPlus: 0.005,
            unit: "mm",
            critical: true,
            sortOrder: 1,
          },
          {
            stage: "FINAL",
            name: "الطول الكلي النهائي",
            nominal: 120,
            tolMinus: 0.02,
            tolPlus: 0.02,
            unit: "mm",
            sortOrder: 2,
          },
          {
            stage: "FINAL",
            name: "الاستدارة (Runout A-B)",
            kind: "GDT",
            gdtSymbol: "⌭",
            gdtLimit: 0.02,
            unit: "mm",
            critical: true,
            sortOrder: 3,
          },
          {
            stage: "FINAL",
            name: "التعامد (Perpendicularity)",
            kind: "GDT",
            gdtSymbol: "⊥",
            gdtLimit: 0.03,
            unit: "mm",
            sortOrder: 4,
          },
        ],
      },
    },
    include: { features: true },
  });

  // ── material 2: a case-hardened shaft ──
  const shaft = await prisma.material.create({
    data: {
      partNumber: "PN-2210-C",
      materialNumber: "1.7131",
      description: "Drive shaft — case hardening steel",
      spec: "DIN 1.7131 / 16MnCr5",
      drawingNumber: "DRW-2210",
      drawingRev: "A",
      hardnessMin: 60,
      hardnessUnit: "HRC",
      surfaceFinishRa: 0.8,
      roughingAllowance: 0.4,
      requiredCerts: "Mill Test Certificate",
      features: {
        create: [
          {
            stage: "POST_ROUGHING",
            name: "قطر المحمل (rough)",
            nominal: 35.4,
            tolMinus: 0.15,
            tolPlus: 0.15,
            unit: "mm",
            sortOrder: 1,
          },
          {
            stage: "POST_GRINDING",
            name: "قطر المحمل",
            nominal: 35.01,
            tolMinus: 0.008,
            tolPlus: 0.008,
            unit: "mm",
            critical: true,
            sortOrder: 1,
          },
          {
            stage: "FINAL",
            name: "قطر المحمل النهائي",
            nominal: 35,
            tolMinus: 0.005,
            tolPlus: 0.005,
            unit: "mm",
            critical: true,
            sortOrder: 1,
          },
          {
            stage: "FINAL",
            name: "التوازي (Concentricity)",
            kind: "GDT",
            gdtSymbol: "⌾",
            gdtLimit: 0.015,
            unit: "mm",
            sortOrder: 2,
          },
        ],
      },
    },
    include: { features: true },
  });

  // ── lots ──
  const lotA = await prisma.lot.create({
    data: {
      lotNumber: "LOT-2026-001",
      materialId: punch.id,
      supplierId: bohler.id,
      receivedAt: daysAgo(21),
      poNumber: "PO-88412",
      heatNumber: "H-55210",
      receivedQty: 40,
      unit: "pcs",
      status: "ACCEPTED",
      certificates: {
        create: [
          {
            type: "Mill Test Certificate",
            number: "MTC-55210",
            received: true,
            verified: true,
            issuedAt: daysAgo(25),
          },
          {
            type: "Heat Treatment Certificate",
            number: "HT-9921",
            received: true,
            verified: true,
            issuedAt: daysAgo(24),
          },
        ],
      },
    },
  });

  const lotB = await prisma.lot.create({
    data: {
      lotNumber: "LOT-2026-002",
      materialId: shaft.id,
      supplierId: dorrenberg.id,
      receivedAt: daysAgo(9),
      poNumber: "PO-88530",
      heatNumber: "H-61044",
      receivedQty: 60,
      unit: "pcs",
      status: "PENDING",
      certificates: {
        // Deliberately not received — the dashboard should flag this lot.
        create: [{ type: "Mill Test Certificate" }],
      },
    },
  });

  const lotC = await prisma.lot.create({
    data: {
      lotNumber: "LOT-2026-003",
      materialId: punch.id,
      supplierId: dorrenberg.id,
      receivedAt: daysAgo(4),
      poNumber: "PO-88604",
      heatNumber: "H-61190",
      receivedQty: 25,
      unit: "pcs",
      status: "REJECTED",
      notes: "صدأ سطحي واضح على 6 قطع + شهادة المصنع غير مطابقة للصهرة.",
      certificates: {
        create: [
          { type: "Mill Test Certificate", number: "MTC-61190", received: true, verified: false },
          { type: "Heat Treatment Certificate" },
        ],
      },
    },
  });

  // ── receiving inspections ──
  async function receivingInspection(
    lotId: number,
    inspector: string,
    at: Date,
    failedKeys: string[] = [],
    status?: Status
  ) {
    const def = stageDef("RAW_RECEIVING");
    const checks = def.items.map((i) => ({
      key: i.key,
      ok: !failedKeys.includes(i.key),
      note: failedKeys.includes(i.key) ? "غير مطابق — راجع الملاحظات" : null,
    }));
    const verdict =
      status ??
      rollup({
        stage: "RAW_RECEIVING",
        checks: Object.fromEntries(checks.map((c) => [c.key, c.ok])),
      }).suggested;

    await prisma.inspection.create({
      data: {
        stage: "RAW_RECEIVING",
        lotId,
        inspector,
        inspectedAt: at,
        status: verdict,
        checks: { create: checks },
      },
    });
  }

  await receivingInspection(lotA.id, "م. أحمد سالم", daysAgo(21));
  await receivingInspection(lotC.id, "م. أحمد سالم", daysAgo(4), ["visual_inspection", "review_certificates"], "REJECTED");

  // ── analysis ──
  const analysisA = await prisma.analysis.create({
    data: {
      lotId: lotA.id,
      sampleRef: "S-001",
      method: "Spectro",
      performedAt: daysAgo(20),
      performedBy: "معمل التحاليل",
      results: {
        create: [
          { property: "C %", requiredMin: 1.45, requiredMax: 1.6, actual: 1.52, unit: "%", sortOrder: 0 },
          { property: "Cr %", requiredMin: 11, requiredMax: 12.5, actual: 11.8, unit: "%", sortOrder: 1 },
          { property: "Mo %", requiredMin: 0.7, requiredMax: 1.0, actual: 0.82, unit: "%", sortOrder: 2 },
          { property: "V %", requiredMin: 0.7, requiredMax: 1.0, actual: 0.9, unit: "%", sortOrder: 3 },
          { property: "P %", requiredMax: 0.03, actual: 0.018, unit: "%", sortOrder: 4 },
          { property: "S %", requiredMax: 0.03, actual: 0.011, unit: "%", sortOrder: 5 },
        ],
      },
    },
    include: { results: true },
  });
  await prisma.analysis.update({
    where: { id: analysisA.id },
    data: {
      status: analysisStatus(analysisA.results),
      conclusion: "مطابق للمواصفة DIN 1.2379.",
    },
  });

  // Lot B's sample is open but unread — it should read as pending everywhere.
  await prisma.analysis.create({
    data: {
      lotId: lotB.id,
      sampleRef: "S-014",
      method: "Spectro",
      performedAt: daysAgo(8),
      performedBy: "معمل التحاليل",
      status: "PENDING",
      results: {
        create: [
          { property: "C %", requiredMin: 0.14, requiredMax: 0.19, unit: "%", sortOrder: 0 },
          { property: "Cr %", requiredMin: 0.8, requiredMax: 1.1, unit: "%", sortOrder: 1 },
          { property: "Mn %", requiredMin: 1.0, requiredMax: 1.3, unit: "%", sortOrder: 2 },
        ],
      },
    },
  });

  // ── parts + their inspections ──
  const features = [...punch.features];

  /** Run one part through `plan`, recording a real inspection per stage. */
  async function runPart(
    serialNumber: string,
    plan: {
      stage: Stage;
      inspector: string;
      at: Date;
      failedKeys?: string[];
      actuals?: Record<string, number>;
      hardness?: number;
      ra?: number;
      cmmRef?: string;
    }[]
  ) {
    const part = await prisma.part.create({
      data: {
        serialNumber,
        materialId: punch.id,
        lotId: lotA.id,
        currentStage: "POST_ROUGHING",
        status: "IN_PROCESS",
      },
    });
    await prisma.partEvent.create({
      data: {
        partId: part.id,
        kind: "CREATED",
        stage: "POST_ROUGHING",
        toValue: "POST_ROUGHING/IN_PROCESS",
        note: `صدر من التشغيلة ${lotA.lotNumber}`,
        at: daysAgo(18),
      },
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
        note: failed.includes(i.key) ? "غير مطابق" : null,
      }));

      const stageFeatures = features.filter((f) => f.stage === step.stage);
      const specs: MeasurementSpec[] = stageFeatures.map((f) => ({
        kind: f.kind,
        nominal: f.nominal,
        tolMinus: f.tolMinus,
        tolPlus: f.tolPlus,
        gdtLimit: f.gdtLimit,
        actual: step.actuals?.[f.name] ?? null,
        critical: f.critical,
      }));
      const measurements = stageFeatures.map((f, i) => ({
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

      await prisma.inspection.create({
        data: {
          stage: step.stage,
          partId: part.id,
          inspector: step.inspector,
          inspectedAt: step.at,
          status: verdict,
          ...(step.stage === "HEAT_TREATMENT"
            ? {
                hardnessValue: step.hardness ?? null,
                hardnessUnit: punch.hardnessUnit,
                hardnessMin: punch.hardnessMin,
                hardnessMax: punch.hardnessMax,
              }
            : {}),
          ...(step.stage === "FINAL"
            ? {
                surfaceFinishRa: step.ra ?? null,
                cmmRequired: step.cmmRef != null,
                cmmReportRef: step.cmmRef ?? null,
                cmmReviewed: step.cmmRef != null,
              }
            : {}),
          checks: { create: checks },
          measurements: { create: measurements },
        },
      });

      const transition = nextPartState(step.stage, verdict);
      await prisma.partEvent.create({
        data: {
          partId: part.id,
          kind: "INSPECTION",
          stage: step.stage,
          fromValue: `${currentStage}/${status}`,
          toValue: `${transition.stage}/${transition.status}`,
          note: `${def.ar} — ${verdict}`,
          actor: step.inspector,
          at: step.at,
        },
      });

      currentStage = transition.stage;
      status = transition.status;
      if (status === "REJECTED" || status === "REWORK" || status === "HOLD") break;
    }

    await prisma.part.update({
      where: { id: part.id },
      data: { currentStage, status },
    });
    return part;
  }

  const goodActuals = {
    roughing: { "القطر الخارجي (rough)": 50.62, "الطول الكلي (rough)": 120.48 },
    grinding: { "القطر الخارجي": 50.021, "الطول الكلي": 120.01 },
    final: {
      "القطر الخارجي النهائي": 50.002,
      "الطول الكلي النهائي": 120.005,
      "الاستدارة (Runout A-B)": 0.011,
      "التعامد (Perpendicularity)": 0.018,
    },
  };

  // Three parts released clean.
  for (let i = 1; i <= 3; i++) {
    await runPart(`LOT-2026-001-${String(i).padStart(4, "0")}`, [
      { stage: "POST_ROUGHING", inspector: "م. هالة فؤاد", at: daysAgo(17), actuals: goodActuals.roughing },
      { stage: "HEAT_TREATMENT", inspector: "م. كريم عادل", at: daysAgo(14), hardness: 60 + i * 0.3 },
      { stage: "POST_GRINDING", inspector: "م. هالة فؤاد", at: daysAgo(10), actuals: goodActuals.grinding },
      {
        stage: "FINAL",
        inspector: "م. منى رشاد",
        at: daysAgo(6),
        actuals: goodActuals.final,
        ra: 0.3,
        cmmRef: `CMM-2026-01${i}`,
      },
    ]);
  }

  // Rejected at final on a critical runout.
  await runPart("LOT-2026-001-0004", [
    { stage: "POST_ROUGHING", inspector: "م. هالة فؤاد", at: daysAgo(17), actuals: goodActuals.roughing },
    { stage: "HEAT_TREATMENT", inspector: "م. كريم عادل", at: daysAgo(14), hardness: 59.4 },
    { stage: "POST_GRINDING", inspector: "م. هالة فؤاد", at: daysAgo(10), actuals: goodActuals.grinding },
    {
      stage: "FINAL",
      inspector: "م. منى رشاد",
      at: daysAgo(5),
      actuals: { ...goodActuals.final, "الاستدارة (Runout A-B)": 0.045 },
      ra: 0.35,
      cmmRef: "CMM-2026-014",
    },
  ]);

  // Soft after heat treatment → rejected there.
  await runPart("LOT-2026-001-0005", [
    { stage: "POST_ROUGHING", inspector: "م. هالة فؤاد", at: daysAgo(17), actuals: goodActuals.roughing },
    { stage: "HEAT_TREATMENT", inspector: "م. كريم عادل", at: daysAgo(13), hardness: 54.5 },
  ]);

  // Over-hard → further investigation, sits on hold.
  await runPart("LOT-2026-001-0006", [
    { stage: "POST_ROUGHING", inspector: "م. هالة فؤاد", at: daysAgo(17), actuals: goodActuals.roughing },
    { stage: "HEAT_TREATMENT", inspector: "م. كريم عادل", at: daysAgo(13), hardness: 64.2 },
  ]);

  // Grinding burn → rework, waiting to be sent back.
  await runPart("LOT-2026-001-0007", [
    { stage: "POST_ROUGHING", inspector: "م. هالة فؤاد", at: daysAgo(17), actuals: goodActuals.roughing },
    { stage: "HEAT_TREATMENT", inspector: "م. كريم عادل", at: daysAgo(13), hardness: 60.1 },
    {
      stage: "POST_GRINDING",
      inspector: "م. هالة فؤاد",
      at: daysAgo(8),
      failedKeys: ["no_grinding_burn"],
      actuals: goodActuals.grinding,
    },
  ]);

  // Three still walking the line, one per queue.
  await runPart("LOT-2026-001-0008", [
    { stage: "POST_ROUGHING", inspector: "م. هالة فؤاد", at: daysAgo(16), actuals: goodActuals.roughing },
    { stage: "HEAT_TREATMENT", inspector: "م. كريم عادل", at: daysAgo(11), hardness: 61 },
    { stage: "POST_GRINDING", inspector: "م. هالة فؤاد", at: daysAgo(7), actuals: goodActuals.grinding },
  ]);
  await runPart("LOT-2026-001-0009", [
    { stage: "POST_ROUGHING", inspector: "م. هالة فؤاد", at: daysAgo(16), actuals: goodActuals.roughing },
    { stage: "HEAT_TREATMENT", inspector: "م. كريم عادل", at: daysAgo(11), hardness: 59.8 },
  ]);
  await runPart("LOT-2026-001-0010", []);

  const counts = {
    suppliers: await prisma.supplier.count(),
    materials: await prisma.material.count(),
    features: await prisma.materialFeature.count(),
    lots: await prisma.lot.count(),
    analyses: await prisma.analysis.count(),
    parts: await prisma.part.count(),
    inspections: await prisma.inspection.count(),
    measurements: await prisma.measurement.count(),
  };
  console.log("Seeded:", counts);
  console.log(`Lots: ${lotA.lotNumber} accepted · ${lotB.lotNumber} pending · ${lotC.lotNumber} rejected`);
  console.log(`Materials: ${punch.partNumber}, ${shaft.partNumber}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
