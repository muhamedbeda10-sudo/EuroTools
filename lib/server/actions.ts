"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import {
  analysisStatus,
  canInspect,
  canRaiseParts,
  measurementResult,
  nextPartState,
  rollup,
  type MeasurementSpec,
} from "@/lib/domain/inspection";
import { isStage, stageDef, type Stage, type Status } from "@/lib/domain/stages";
import { optionalNumber, optionalString, triState } from "@/lib/format";

export interface ActionResult {
  ok: boolean;
  error?: string;
  info?: string;
}

// ───────────────────────── catalog ─────────────────────────

export async function saveMaterial(formData: FormData): Promise<ActionResult> {
  const partNumber = String(formData.get("partNumber") ?? "").trim();
  if (!partNumber) return { ok: false, error: "رقم الجزء مطلوب." };

  const id = optionalNumber(formData.get("id"));
  const data = {
    partNumber,
    materialNumber: optionalString(formData.get("materialNumber")),
    description: optionalString(formData.get("description")),
    spec: optionalString(formData.get("spec")),
    drawingNumber: optionalString(formData.get("drawingNumber")),
    drawingRev: optionalString(formData.get("drawingRev")),
    hardnessMin: optionalNumber(formData.get("hardnessMin")),
    hardnessMax: optionalNumber(formData.get("hardnessMax")),
    hardnessUnit: optionalString(formData.get("hardnessUnit")) ?? "HRC",
    surfaceFinishRa: optionalNumber(formData.get("surfaceFinishRa")),
    requiredCerts: optionalString(formData.get("requiredCerts")),
    roughingAllowance: optionalNumber(formData.get("roughingAllowance")),
  };

  if (data.hardnessMin != null && data.hardnessMax != null && data.hardnessMin > data.hardnessMax)
    return { ok: false, error: "الحد الأدنى للصلادة أكبر من الحد الأقصى." };

  const existing = await prisma.material.findUnique({ where: { partNumber } });
  if (existing && existing.id !== id)
    return { ok: false, error: `رقم الجزء ${partNumber} مسجل بالفعل.` };

  if (id) await prisma.material.update({ where: { id }, data });
  else await prisma.material.create({ data });

  revalidatePath("/materials");
  return { ok: true, info: "تم حفظ المواصفة." };
}

export async function addFeature(formData: FormData): Promise<ActionResult> {
  const materialId = optionalNumber(formData.get("materialId"));
  const stage = String(formData.get("stage") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!materialId || !name) return { ok: false, error: "بيانات ناقصة." };
  if (!isStage(stage) || stageDef(stage).subject !== "PART")
    return { ok: false, error: "مرحلة غير صالحة للقياس." };

  const kind = String(formData.get("kind") ?? "DIMENSION") === "GDT" ? "GDT" : "DIMENSION";
  const nominal = optionalNumber(formData.get("nominal"));
  const gdtLimit = optionalNumber(formData.get("gdtLimit"));

  if (kind === "DIMENSION" && nominal == null)
    return { ok: false, error: "القيمة الاسمية مطلوبة للبعد." };
  if (kind === "GDT" && gdtLimit == null)
    return { ok: false, error: "قيمة الـ GD&T المسموحة مطلوبة." };

  const last = await prisma.materialFeature.findFirst({
    where: { materialId, stage },
    orderBy: { sortOrder: "desc" },
  });

  await prisma.materialFeature.create({
    data: {
      materialId,
      stage,
      name,
      kind,
      nominal,
      tolMinus: Math.abs(optionalNumber(formData.get("tolMinus")) ?? 0),
      tolPlus: Math.abs(optionalNumber(formData.get("tolPlus")) ?? 0),
      unit: optionalString(formData.get("unit")) ?? "mm",
      critical: formData.get("critical") === "on",
      gdtSymbol: optionalString(formData.get("gdtSymbol")),
      gdtLimit,
      sortOrder: (last?.sortOrder ?? 0) + 1,
    },
  });

  revalidatePath(`/materials/${materialId}`);
  return { ok: true, info: "تمت إضافة الخاصية." };
}

export async function deleteFeature(formData: FormData): Promise<ActionResult> {
  const id = optionalNumber(formData.get("id"));
  if (!id) return { ok: false, error: "معرّف غير صالح." };
  const feature = await prisma.materialFeature.findUnique({ where: { id } });
  if (!feature) return { ok: false, error: "الخاصية غير موجودة." };
  await prisma.materialFeature.delete({ where: { id } });
  revalidatePath(`/materials/${feature.materialId}`);
  return { ok: true, info: "تم الحذف." };
}

export async function saveSupplier(formData: FormData): Promise<ActionResult> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "اسم المورد مطلوب." };
  const existing = await prisma.supplier.findUnique({ where: { name } });
  if (existing) return { ok: false, error: "المورد مسجل بالفعل." };
  await prisma.supplier.create({
    data: {
      name,
      code: optionalString(formData.get("code")),
      contact: optionalString(formData.get("contact")),
    },
  });
  revalidatePath("/materials");
  revalidatePath("/lots");
  return { ok: true, info: "تم حفظ المورد." };
}

// ────────────────── 1 · raw material receiving ──────────────────

export async function receiveLot(formData: FormData): Promise<ActionResult> {
  const lotNumber = String(formData.get("lotNumber") ?? "").trim();
  const materialId = optionalNumber(formData.get("materialId"));
  const receivedQty = optionalNumber(formData.get("receivedQty"));

  if (!lotNumber) return { ok: false, error: "رقم التشغيلة مطلوب." };
  if (!materialId) return { ok: false, error: "اختر الخامة / رقم الجزء." };
  if (receivedQty == null || receivedQty <= 0)
    return { ok: false, error: "الكمية المستلمة يجب أن تكون أكبر من صفر." };

  const clash = await prisma.lot.findUnique({ where: { lotNumber } });
  if (clash) return { ok: false, error: `رقم التشغيلة ${lotNumber} مسجل بالفعل.` };

  const material = await prisma.material.findUnique({ where: { id: materialId } });
  if (!material) return { ok: false, error: "الخامة غير موجودة." };

  const receivedAtRaw = optionalString(formData.get("receivedAt"));
  const receivedAt = receivedAtRaw ? new Date(receivedAtRaw) : new Date();
  if (Number.isNaN(receivedAt.getTime()))
    return { ok: false, error: "تاريخ الاستلام غير صالح." };

  const lot = await prisma.lot.create({
    data: {
      lotNumber,
      materialId,
      supplierId: optionalNumber(formData.get("supplierId")),
      receivedAt,
      poNumber: optionalString(formData.get("poNumber")),
      heatNumber: optionalString(formData.get("heatNumber")),
      receivedQty,
      unit: optionalString(formData.get("unit")) ?? "pcs",
      notes: optionalString(formData.get("notes")),
      // Every certificate the material requires is pre-listed as "not received"
      // so the receiving clerk ticks them off rather than remembering them.
      certificates: {
        create: (material.requiredCerts ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((type) => ({ type })),
      },
    },
  });

  revalidatePath("/lots");
  redirect(`/lots/${lot.id}`);
}

export async function setCertificate(formData: FormData): Promise<ActionResult> {
  const id = optionalNumber(formData.get("id"));
  if (!id) return { ok: false, error: "معرّف غير صالح." };
  const cert = await prisma.certificate.findUnique({ where: { id } });
  if (!cert) return { ok: false, error: "الشهادة غير موجودة." };

  await prisma.certificate.update({
    where: { id },
    data: {
      number: optionalString(formData.get("number")),
      received: formData.get("received") === "on",
      verified: formData.get("verified") === "on",
      notes: optionalString(formData.get("notes")),
    },
  });
  revalidatePath(`/lots/${cert.lotId}`);
  return { ok: true, info: "تم تحديث الشهادة." };
}

export async function addCertificate(formData: FormData): Promise<ActionResult> {
  const lotId = optionalNumber(formData.get("lotId"));
  const type = String(formData.get("type") ?? "").trim();
  if (!lotId || !type) return { ok: false, error: "نوع الشهادة مطلوب." };
  await prisma.certificate.create({
    data: { lotId, type, number: optionalString(formData.get("number")) },
  });
  revalidatePath(`/lots/${lotId}`);
  return { ok: true, info: "تمت إضافة الشهادة." };
}

// ──────────────────── 2 · raw material analysis ────────────────────

export async function createAnalysis(formData: FormData): Promise<ActionResult> {
  const lotId = optionalNumber(formData.get("lotId"));
  const sampleRef = String(formData.get("sampleRef") ?? "").trim();
  if (!lotId || !sampleRef) return { ok: false, error: "مرجع العينة مطلوب." };

  // Chemistry lines the lab fills in. Kept as free rows so a different alloy
  // can be analysed without a schema change.
  const properties = formData.getAll("property").map((v) => String(v).trim());
  const mins = formData.getAll("requiredMin");
  const maxes = formData.getAll("requiredMax");
  const units = formData.getAll("unit");

  const results = properties
    .map((property, i) => ({
      property,
      requiredMin: optionalNumber(mins[i] ?? null),
      requiredMax: optionalNumber(maxes[i] ?? null),
      unit: optionalString(units[i] ?? null),
      sortOrder: i,
    }))
    .filter((r) => r.property !== "");

  const analysis = await prisma.analysis.create({
    data: {
      lotId,
      sampleRef,
      method: optionalString(formData.get("method")),
      performedBy: optionalString(formData.get("performedBy")),
      status: "PENDING",
      results: { create: results },
    },
  });

  revalidatePath(`/lots/${lotId}`);
  return { ok: true, info: `تم فتح تحليل رقم ${analysis.id}.` };
}

export async function saveAnalysisResults(formData: FormData): Promise<ActionResult> {
  const analysisId = optionalNumber(formData.get("analysisId"));
  if (!analysisId) return { ok: false, error: "معرّف غير صالح." };

  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    include: { results: true },
  });
  if (!analysis) return { ok: false, error: "التحليل غير موجود." };

  const updates = analysis.results.map((r) => ({
    id: r.id,
    actual: optionalNumber(formData.get(`actual_${r.id}`)),
    actualText: optionalString(formData.get(`actualText_${r.id}`)),
  }));

  const merged = analysis.results.map((r) => {
    const u = updates.find((x) => x.id === r.id)!;
    return { ...r, actual: u.actual, actualText: u.actualText };
  });
  const status = analysisStatus(merged);

  await prisma.$transaction([
    ...updates.map((u) =>
      prisma.analysisResult.update({
        where: { id: u.id },
        data: { actual: u.actual, actualText: u.actualText },
      })
    ),
    prisma.analysis.update({
      where: { id: analysisId },
      data: {
        status,
        conclusion: optionalString(formData.get("conclusion")),
        actionTaken: optionalString(formData.get("actionTaken")),
        performedBy: optionalString(formData.get("performedBy")) ?? analysis.performedBy,
      },
    }),
  ]);

  revalidatePath(`/lots/${analysis.lotId}`);
  return { ok: true, info: `تم حفظ النتائج — الحالة: ${status}.` };
}

// ─────────────── shared · the checklist submit path ───────────────

/** Read the tri-state answers for a stage out of the posted form. */
function readChecks(stage: Stage, formData: FormData) {
  const def = stageDef(stage);
  return def.items.map((item) => ({
    key: item.key,
    ok: triState(formData.get(`check_${item.key}`)),
    note: optionalString(formData.get(`note_${item.key}`)),
  }));
}

export async function submitLotInspection(formData: FormData): Promise<ActionResult> {
  const lotId = optionalNumber(formData.get("lotId"));
  const inspector = String(formData.get("inspector") ?? "").trim();
  if (!lotId) return { ok: false, error: "معرّف التشغيلة غير صالح." };
  if (!inspector) return { ok: false, error: "اسم الفاحص مطلوب." };

  const lot = await prisma.lot.findUnique({
    where: { id: lotId },
    include: { material: true, certificates: true },
  });
  if (!lot) return { ok: false, error: "التشغيلة غير موجودة." };

  const stage: Stage = "RAW_RECEIVING";
  const checks = readChecks(stage, formData);
  const checkMap = Object.fromEntries(checks.map((c) => [c.key, c.ok]));
  const suggestion = rollup({ stage, checks: checkMap });

  const chosen = String(formData.get("status") ?? "").trim();
  const status: Status =
    chosen && stageDef(stage).outcomes.includes(chosen as Status)
      ? (chosen as Status)
      : suggestion.suggested;

  await prisma.$transaction([
    prisma.inspection.create({
      data: {
        stage,
        lotId,
        inspector,
        status,
        notes: optionalString(formData.get("notes")),
        checks: { create: checks },
      },
    }),
    prisma.lot.update({
      where: { id: lotId },
      // A lot mirrors its receiving verdict; PENDING keeps it in the queue.
      data: { status: status === "PENDING" ? "PENDING" : status },
    }),
  ]);

  revalidatePath(`/lots/${lotId}`);
  revalidatePath("/lots");
  revalidatePath("/");
  return { ok: true, info: `تم تسجيل الفحص — الحالة: ${status}.` };
}

export async function submitPartInspection(formData: FormData): Promise<ActionResult> {
  const partId = optionalNumber(formData.get("partId"));
  const stageRaw = String(formData.get("stage") ?? "");
  const inspector = String(formData.get("inspector") ?? "").trim();

  if (!partId) return { ok: false, error: "معرّف الجزء غير صالح." };
  if (!isStage(stageRaw)) return { ok: false, error: "مرحلة غير معروفة." };
  if (!inspector) return { ok: false, error: "اسم الفاحص مطلوب." };

  const stage = stageRaw as Stage;
  const def = stageDef(stage);
  if (def.subject !== "PART") return { ok: false, error: "هذه المرحلة ليست مرحلة أجزاء." };

  const part = await prisma.part.findUnique({
    where: { id: partId },
    include: { material: { include: { features: true } } },
  });
  if (!part) return { ok: false, error: "الجزء غير موجود." };

  const gate = canInspect(part, stage);
  if (!gate.ok) return { ok: false, error: gate.reason };

  const checks = readChecks(stage, formData);
  const checkMap = Object.fromEntries(checks.map((c) => [c.key, c.ok]));

  // Measurements come from the material's feature list for this stage; the
  // nominal and tolerances are copied in so the record reads on its own even
  // after the drawing is revised.
  const features = part.material.features.filter((f) => f.stage === stage);
  const specs: MeasurementSpec[] = features.map((f) => ({
    kind: f.kind,
    nominal: f.nominal,
    tolMinus: f.tolMinus,
    tolPlus: f.tolPlus,
    gdtLimit: f.gdtLimit,
    actual: optionalNumber(formData.get(`actual_${f.id}`)),
    critical: f.critical,
  }));
  const measurements = features.map((f, i) => ({
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
    stage === "HEAT_TREATMENT"
      ? {
          value: optionalNumber(formData.get("hardnessValue")),
          min: part.material.hardnessMin,
          max: part.material.hardnessMax,
        }
      : undefined;

  const suggestion = rollup({ stage, checks: checkMap, measurements: specs, hardness });

  const chosen = String(formData.get("status") ?? "").trim();
  const status: Status =
    chosen && def.outcomes.includes(chosen as Status)
      ? (chosen as Status)
      : suggestion.suggested;

  // PENDING means "sheet not finished" — the part must not move.
  const transition =
    status === "PENDING"
      ? { stage: part.currentStage as Stage, status: part.status as "IN_PROCESS" }
      : nextPartState(stage, status);

  await prisma.$transaction(async (tx) => {
    await tx.inspection.create({
      data: {
        stage,
        partId,
        inspector,
        status,
        notes: optionalString(formData.get("notes")),
        ...(stage === "HEAT_TREATMENT"
          ? {
              hardnessValue: hardness?.value ?? null,
              hardnessUnit: part.material.hardnessUnit,
              hardnessMin: part.material.hardnessMin,
              hardnessMax: part.material.hardnessMax,
            }
          : {}),
        ...(stage === "FINAL"
          ? {
              surfaceFinishRa: optionalNumber(formData.get("surfaceFinishRa")),
              cmmRequired: formData.get("cmmRequired") === "on",
              cmmReportRef: optionalString(formData.get("cmmReportRef")),
              cmmReviewed: formData.get("cmmReviewed") === "on",
            }
          : {}),
        checks: { create: checks },
        measurements: { create: measurements },
      },
    });

    await tx.part.update({
      where: { id: partId },
      data: { currentStage: transition.stage, status: transition.status },
    });

    await tx.partEvent.create({
      data: {
        partId,
        kind: "INSPECTION",
        stage,
        fromValue: `${part.currentStage}/${part.status}`,
        toValue: `${transition.stage}/${transition.status}`,
        note: `${def.ar} — ${status}`,
        actor: inspector,
      },
    });
  });

  revalidatePath(`/parts/${partId}`);
  revalidatePath("/parts");
  revalidatePath("/queue");
  revalidatePath("/");
  return {
    ok: true,
    info: `تم تسجيل الفحص — الحالة: ${status}. الجزء الآن في: ${transition.stage}.`,
  };
}

// ───────────────────────── parts ─────────────────────────

export async function raiseParts(formData: FormData): Promise<ActionResult> {
  const lotId = optionalNumber(formData.get("lotId"));
  const count = optionalNumber(formData.get("count"));
  const prefix = String(formData.get("prefix") ?? "").trim();

  if (!lotId) return { ok: false, error: "معرّف التشغيلة غير صالح." };
  if (count == null || count < 1 || count > 500)
    return { ok: false, error: "العدد يجب أن يكون بين 1 و 500." };
  if (!prefix) return { ok: false, error: "بادئة الرقم المسلسل مطلوبة." };

  const lot = await prisma.lot.findUnique({
    where: { id: lotId },
    include: { analyses: true },
  });
  if (!lot) return { ok: false, error: "التشغيلة غير موجودة." };

  const gate = canRaiseParts(lot);
  if (!gate.ok) return { ok: false, error: gate.reason };

  const existing = await prisma.part.count({ where: { lotId } });
  const serials = Array.from({ length: Math.trunc(count) }, (_, i) =>
    `${prefix}-${String(existing + i + 1).padStart(4, "0")}`
  );

  const clash = await prisma.part.findFirst({
    where: { serialNumber: { in: serials } },
  });
  if (clash)
    return { ok: false, error: `الرقم المسلسل ${clash.serialNumber} مستخدم بالفعل.` };

  await prisma.$transaction(async (tx) => {
    for (const serialNumber of serials) {
      const part = await tx.part.create({
        data: {
          serialNumber,
          materialId: lot.materialId,
          lotId,
          currentStage: "POST_ROUGHING",
          status: "IN_PROCESS",
        },
      });
      await tx.partEvent.create({
        data: {
          partId: part.id,
          kind: "CREATED",
          stage: "POST_ROUGHING",
          toValue: "POST_ROUGHING/IN_PROCESS",
          note: `صدر من التشغيلة ${lot.lotNumber}`,
        },
      });
    }
  });

  revalidatePath(`/lots/${lotId}`);
  revalidatePath("/parts");
  revalidatePath("/queue");
  return { ok: true, info: `تم إصدار ${serials.length} جزء.` };
}

/** Send a reworked part back into its queue once the shop has redone it. */
export async function returnPartToQueue(formData: FormData): Promise<ActionResult> {
  const partId = optionalNumber(formData.get("partId"));
  const actor = optionalString(formData.get("actor"));
  if (!partId) return { ok: false, error: "معرّف غير صالح." };

  const part = await prisma.part.findUnique({ where: { id: partId } });
  if (!part) return { ok: false, error: "الجزء غير موجود." };
  if (part.status !== "REWORK" && part.status !== "HOLD")
    return { ok: false, error: "هذا الجزء ليس في إعادة تشغيل أو إيقاف." };

  await prisma.$transaction([
    prisma.part.update({ where: { id: partId }, data: { status: "IN_PROCESS" } }),
    prisma.partEvent.create({
      data: {
        partId,
        kind: "STATUS_CHANGE",
        stage: part.currentStage,
        fromValue: part.status,
        toValue: "IN_PROCESS",
        note: "أُعيد إلى طابور الفحص بعد المعالجة",
        actor,
      },
    }),
  ]);

  revalidatePath(`/parts/${partId}`);
  revalidatePath("/queue");
  return { ok: true, info: "تمت إعادة الجزء إلى الطابور." };
}
