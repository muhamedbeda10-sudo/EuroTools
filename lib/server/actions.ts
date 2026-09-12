"use server";

import { revalidatePath } from "next/cache";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

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
import { verdictPermission } from "@/lib/domain/roles";
import { requirePermission } from "@/lib/server/auth";
import { db } from "@/lib/server/firestore";
import {
  analysesOf,
  eventsOf,
  inspections,
  lots,
  materials,
  parts,
  newId,
  releaseUnique,
  reserveUnique,
  stats,
  suppliers,
  uniqueKey,
  uniques,
  users,
  type AnalysisDoc,
  type CertificateEntry,
  type FeatureEntry,
  type InspectionDoc,
  type LotDoc,
  type MaterialDoc,
  type MeasurementEntry,
  type PartDoc,
} from "@/lib/server/model";
import { optionalNumber, optionalString, triState } from "@/lib/format";

export interface ActionResult {
  ok: boolean;
  error?: string;
  info?: string;
}

/** Every action below opens with `requirePermission`. That call is the real
 *  authorisation boundary — `proxy.ts` only keeps signed-out traffic off the
 *  pages, and a hidden button is not a control. A denial is returned rather
 *  than thrown so it reaches the operator as the form's error line, the same
 *  way every other failure in this app does.
 *
 *  Identity is read from the session too, never from the submitted form. A
 *  signature the client could type is not a signature.
 *
 *  ## What replaced the database constraints
 *
 *  Firestore has neither unique indexes nor foreign keys, so two guarantees
 *  that used to be the database's are now this file's, and both are held
 *  inside the same transaction as the write they protect:
 *
 *  - **Uniqueness** is a reservation document whose id *is* the value, so two
 *    writers racing for one part number both try to create the same document
 *    and exactly one wins. See `reserveUnique`.
 *  - **Counts** that reports and dashboards read — a lot's parts, a material's
 *    lots, an account's signed inspections, the per-line failure tally — are
 *    incremented alongside the record they describe. Because the increment and
 *    the record commit together, they cannot drift apart.
 */

const now = () => Timestamp.now();

/** Reject a reserved value with a message naming what actually clashed. */
function clashMessage(what: string, value: string): string {
  return `${what} ${value} مسجل بالفعل.`;
}

// ───────────────────────── catalog ─────────────────────────

export async function saveMaterial(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("material.manage");
  if (!auth.ok) return auth;

  const partNumber = String(formData.get("partNumber") ?? "").trim();
  if (!partNumber) return { ok: false, error: "رقم الجزء مطلوب." };

  const id = optionalString(formData.get("id"));
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

  const ref = id ? materials().doc(id) : materials().doc();

  try {
    await db().runTransaction(async (tx) => {
      const existing = id ? await tx.get(ref) : null;
      if (id && (!existing || !existing.exists)) throw new Error("NOT_FOUND");

      const previous = existing?.data() as MaterialDoc | undefined;

      // Reads before writes, which Firestore requires, so the reservation is
      // taken while the transaction can still see a competing one.
      const claim = await reserveUnique(tx, "material.partNumber", partNumber, ref.path);
      if (!claim.ok) throw new Error("CLASH");

      if (previous && previous.partNumber !== partNumber)
        releaseUnique(tx, "material.partNumber", previous.partNumber);

      if (previous) {
        tx.update(ref, data);
      } else {
        tx.create(ref, {
          ...data,
          createdAt: now(),
          features: [],
          lotCount: 0,
          partCount: 0,
        });
      }
    });
  } catch (error) {
    if ((error as Error).message === "CLASH")
      return { ok: false, error: clashMessage("رقم الجزء", partNumber) };
    if ((error as Error).message === "NOT_FOUND")
      return { ok: false, error: "المواصفة غير موجودة." };
    throw error;
  }

  revalidatePath("/materials");
  revalidatePath(`/materials/${ref.id}`);
  return { ok: true, info: "تم حفظ المواصفة." };
}

export async function addFeature(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("material.manage");
  if (!auth.ok) return auth;

  const materialId = optionalString(formData.get("materialId"));
  const stage = String(formData.get("stage") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!materialId) return { ok: false, error: "معرّف المواصفة غير صالح." };
  if (!name) return { ok: false, error: "اسم الخاصية مطلوب." };
  if (!isStage(stage)) return { ok: false, error: "مرحلة غير معروفة." };

  const kind = String(formData.get("kind") ?? "DIMENSION") === "GDT" ? "GDT" : "DIMENSION";
  const ref = materials().doc(materialId);

  try {
    await db().runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error("NOT_FOUND");

      const material = snapshot.data() as MaterialDoc;
      const features = material.features ?? [];

      const feature: FeatureEntry = {
        id: newId(), // a generated id, used only to address the entry
        stage,
        name,
        kind,
        nominal: optionalNumber(formData.get("nominal")),
        tolMinus: optionalNumber(formData.get("tolMinus")) ?? 0,
        tolPlus: optionalNumber(formData.get("tolPlus")) ?? 0,
        unit: optionalString(formData.get("unit")) ?? "mm",
        critical: formData.get("critical") === "on",
        gdtSymbol: optionalString(formData.get("gdtSymbol")),
        gdtLimit: optionalNumber(formData.get("gdtLimit")),
        sortOrder: features.filter((f) => f.stage === stage).length,
      };

      tx.update(ref, { features: [...features, feature] });
    });
  } catch (error) {
    if ((error as Error).message === "NOT_FOUND")
      return { ok: false, error: "المواصفة غير موجودة." };
    throw error;
  }

  revalidatePath(`/materials/${materialId}`);
  return { ok: true, info: "تمت إضافة الخاصية." };
}

export async function deleteFeature(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("material.manage");
  if (!auth.ok) return auth;

  const materialId = optionalString(formData.get("materialId"));
  const featureId = optionalString(formData.get("id"));
  if (!materialId || !featureId) return { ok: false, error: "معرّف غير صالح." };

  const ref = materials().doc(materialId);
  await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return;
    const material = snapshot.data() as MaterialDoc;
    tx.update(ref, { features: (material.features ?? []).filter((f) => f.id !== featureId) });
  });

  revalidatePath(`/materials/${materialId}`);
  return { ok: true, info: "تم حذف الخاصية." };
}

export async function saveSupplier(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("supplier.manage");
  if (!auth.ok) return auth;

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "اسم المورد مطلوب." };

  const id = optionalString(formData.get("id"));
  const data = {
    name,
    code: optionalString(formData.get("code")),
    contact: optionalString(formData.get("contact")),
    notes: optionalString(formData.get("notes")),
  };

  const ref = id ? suppliers().doc(id) : suppliers().doc();

  try {
    await db().runTransaction(async (tx) => {
      const existing = id ? await tx.get(ref) : null;
      const previous = existing?.data() as { name: string } | undefined;

      const claim = await reserveUnique(tx, "supplier.name", name, ref.path);
      if (!claim.ok) throw new Error("CLASH");

      if (previous && previous.name !== name) releaseUnique(tx, "supplier.name", previous.name);

      if (previous) tx.update(ref, data);
      else tx.create(ref, { ...data, createdAt: now() });
    });
  } catch (error) {
    if ((error as Error).message === "CLASH")
      return { ok: false, error: clashMessage("اسم المورد", name) };
    throw error;
  }

  revalidatePath("/lots/new");
  return { ok: true, info: "تم حفظ المورد." };
}

// ───────────────────── 1 · raw material receiving ─────────────────────

export async function receiveLot(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("lot.receive");
  if (!auth.ok) return auth;

  const lotNumber = String(formData.get("lotNumber") ?? "").trim();
  const materialId = optionalString(formData.get("materialId"));
  const receivedQty = optionalNumber(formData.get("receivedQty"));

  if (!lotNumber) return { ok: false, error: "رقم التشغيلة مطلوب." };
  if (!materialId) return { ok: false, error: "اختر المواصفة." };
  if (receivedQty == null || receivedQty <= 0)
    return { ok: false, error: "الكمية المستلمة يجب أن تكون أكبر من صفر." };

  const receivedAtRaw = optionalString(formData.get("receivedAt"));
  const receivedAt = receivedAtRaw ? new Date(receivedAtRaw) : new Date();
  if (Number.isNaN(receivedAt.getTime())) return { ok: false, error: "تاريخ الاستلام غير صالح." };

  const ref = lots().doc();

  try {
    await db().runTransaction(async (tx) => {
      const materialRef = materials().doc(materialId);
      const materialSnap = await tx.get(materialRef);
      if (!materialSnap.exists) throw new Error("NO_MATERIAL");

      const claim = await reserveUnique(tx, "lot.lotNumber", lotNumber, ref.path);
      if (!claim.ok) throw new Error("CLASH");

      tx.create(ref, {
        lotNumber,
        materialId,
        supplierId: optionalString(formData.get("supplierId")),
        receivedAt: Timestamp.fromDate(receivedAt),
        poNumber: optionalString(formData.get("poNumber")),
        heatNumber: optionalString(formData.get("heatNumber")),
        receivedQty,
        unit: optionalString(formData.get("unit")) ?? "pcs",
        status: "PENDING",
        notes: optionalString(formData.get("notes")),
        createdAt: now(),
        certificates: [],
        partCount: 0,
        analysisCounts: { total: 0, pending: 0, accepted: 0, rejected: 0 },
      } satisfies LotDoc);

      tx.update(materialRef, { lotCount: FieldValue.increment(1) });
    });
  } catch (error) {
    const message = (error as Error).message;
    if (message === "CLASH") return { ok: false, error: clashMessage("رقم التشغيلة", lotNumber) };
    if (message === "NO_MATERIAL") return { ok: false, error: "المواصفة غير موجودة." };
    throw error;
  }

  revalidatePath("/lots");
  revalidatePath("/");
  return { ok: true, info: `تم تسجيل استلام التشغيلة ${lotNumber}.` };
}

export async function addCertificate(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("lot.certificate.manage");
  if (!auth.ok) return auth;

  const lotId = optionalString(formData.get("lotId"));
  const type = String(formData.get("type") ?? "").trim();
  if (!lotId) return { ok: false, error: "معرّف التشغيلة غير صالح." };
  if (!type) return { ok: false, error: "نوع الشهادة مطلوب." };

  const issuedAtRaw = optionalString(formData.get("issuedAt"));
  const issuedAt = issuedAtRaw ? new Date(issuedAtRaw) : null;
  if (issuedAt && Number.isNaN(issuedAt.getTime()))
    return { ok: false, error: "تاريخ الإصدار غير صالح." };

  const ref = lots().doc(lotId);
  await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) throw new Error("NOT_FOUND");

    const lot = snapshot.data() as LotDoc;
    const certificate: CertificateEntry = {
      id: newId(),
      type,
      number: optionalString(formData.get("number")),
      issuedAt: issuedAt ? Timestamp.fromDate(issuedAt) : null,
      received: formData.get("received") === "on",
      verified: formData.get("verified") === "on",
      notes: optionalString(formData.get("notes")),
    };

    tx.update(ref, { certificates: [...(lot.certificates ?? []), certificate] });
  });

  revalidatePath(`/lots/${lotId}`);
  return { ok: true, info: "تمت إضافة الشهادة." };
}

export async function setCertificate(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("lot.certificate.manage");
  if (!auth.ok) return auth;

  const lotId = optionalString(formData.get("lotId"));
  const certificateId = optionalString(formData.get("id"));
  if (!lotId || !certificateId) return { ok: false, error: "معرّف غير صالح." };

  const ref = lots().doc(lotId);
  await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return;

    const lot = snapshot.data() as LotDoc;
    tx.update(ref, {
      certificates: (lot.certificates ?? []).map((c) =>
        c.id === certificateId
          ? {
              ...c,
              received: formData.get("received") === "on",
              verified: formData.get("verified") === "on",
            }
          : c
      ),
    });
  });

  revalidatePath(`/lots/${lotId}`);
  revalidatePath("/");
  return { ok: true, info: "تم تحديث الشهادة." };
}

// ───────────────────── 2 · raw material analysis ─────────────────────

export async function createAnalysis(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("analysis.record");
  if (!auth.ok) return auth;

  const lotId = optionalString(formData.get("lotId"));
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
      id: newId(),
      property,
      requiredMin: optionalNumber(mins[i] ?? null),
      requiredMax: optionalNumber(maxes[i] ?? null),
      requiredText: null,
      actual: null,
      actualText: null,
      unit: optionalString(units[i] ?? null),
      pass: null,
      sortOrder: i,
    }))
    .filter((r) => r.property !== "");

  const lotRef = lots().doc(lotId);
  const analysisRef = analysesOf(lotId).doc();

  try {
    await db().runTransaction(async (tx) => {
      const lotSnap = await tx.get(lotRef);
      if (!lotSnap.exists) throw new Error("NOT_FOUND");

      tx.create(analysisRef, {
        sampleRef,
        method: optionalString(formData.get("method")),
        performedAt: now(),
        // Who ran the test may be an outside laboratory; who is answerable for
        // the record is always the account that entered it.
        performedBy: optionalString(formData.get("performedBy")),
        recordedByUid: auth.user.uid,
        recordedByName: auth.user.displayName,
        status: "PENDING",
        conclusion: null,
        actionTaken: null,
        results,
      } satisfies AnalysisDoc);

      tx.update(lotRef, {
        "analysisCounts.total": FieldValue.increment(1),
        "analysisCounts.pending": FieldValue.increment(1),
      });
    });
  } catch (error) {
    if ((error as Error).message === "NOT_FOUND")
      return { ok: false, error: "التشغيلة غير موجودة." };
    throw error;
  }

  revalidatePath(`/lots/${lotId}`);
  revalidatePath("/");
  return { ok: true, info: "تم فتح تحليل جديد." };
}

export async function saveAnalysisResults(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("analysis.record");
  if (!auth.ok) return auth;

  const lotId = optionalString(formData.get("lotId"));
  const analysisId = optionalString(formData.get("analysisId"));
  if (!lotId || !analysisId) return { ok: false, error: "معرّف غير صالح." };

  const lotRef = lots().doc(lotId);
  const analysisRef = analysesOf(lotId).doc(analysisId);
  let status: Status = "PENDING";

  try {
    await db().runTransaction(async (tx) => {
      const [analysisSnap, lotSnap] = await Promise.all([tx.get(analysisRef), tx.get(lotRef)]);
      if (!analysisSnap.exists || !lotSnap.exists) throw new Error("NOT_FOUND");

      const analysis = analysisSnap.data() as AnalysisDoc;
      const merged = (analysis.results ?? []).map((r) => ({
        ...r,
        actual: optionalNumber(formData.get(`actual_${r.id}`)),
        actualText: optionalString(formData.get(`actualText_${r.id}`)),
      }));

      status = analysisStatus(merged);
      const previous = analysis.status;

      tx.update(analysisRef, {
        results: merged,
        status,
        conclusion: optionalString(formData.get("conclusion")),
        actionTaken: optionalString(formData.get("actionTaken")),
        performedBy: optionalString(formData.get("performedBy")) ?? analysis.performedBy,
      });

      // Move the lot's tally from the old verdict to the new one, so the
      // dashboard's "waiting on analysis" list stays true without reading
      // every analysis.
      if (previous !== status) {
        const bucket = (s: string) =>
          s === "ACCEPTED" ? "accepted" : s === "REJECTED" ? "rejected" : "pending";
        tx.update(lotRef, {
          [`analysisCounts.${bucket(previous)}`]: FieldValue.increment(-1),
          [`analysisCounts.${bucket(status)}`]: FieldValue.increment(1),
        });
      }
    });
  } catch (error) {
    if ((error as Error).message === "NOT_FOUND")
      return { ok: false, error: "التحليل غير موجود." };
    throw error;
  }

  revalidatePath(`/lots/${lotId}`);
  revalidatePath("/");
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

/** The per-line failure tally the reports page reads.
 *
 *  Incremented inside the transaction that files the inspection, so the count
 *  and the record it counts commit together. Field names carry the stage so
 *  the same checklist key in two stages stays two rows; `FieldPath` takes the
 *  segments literally, which matters because the key contains a separator that
 *  a dotted path string would split on.
 */
function tallyFailures(
  tx: FirebaseFirestore.Transaction,
  stage: Stage,
  checks: { key: string; ok: boolean | null }[]
): void {
  const failed = checks.filter((c) => c.ok === false);
  if (failed.length === 0) return;

  const ref = stats().doc("failures");
  for (const check of failed)
    tx.set(
      ref,
      { counts: { [`${stage}::${check.key}`]: FieldValue.increment(1) } },
      { merge: true }
    );
}

export async function submitLotInspection(formData: FormData): Promise<ActionResult> {
  // A first gate before touching the database, so an account with no business
  // here cannot use this action to find out which lots exist. The verdict is
  // gated again below, once we know what it is.
  const entry = await requirePermission("inspection.submit");
  if (!entry.ok) return entry;
  const inspector = entry.user.displayName;

  const lotId = optionalString(formData.get("lotId"));
  if (!lotId) return { ok: false, error: "معرّف التشغيلة غير صالح." };

  const lotSnap = await lots().doc(lotId).get();
  if (!lotSnap.exists) return { ok: false, error: "التشغيلة غير موجودة." };
  const lot = lotSnap.data() as LotDoc;

  const materialSnap = await materials().doc(lot.materialId).get();
  const material = materialSnap.data() as MaterialDoc | undefined;

  const stage: Stage = "RAW_RECEIVING";
  const checks = readChecks(stage, formData);
  const checkMap = Object.fromEntries(checks.map((c) => [c.key, c.ok]));
  const suggestion = rollup({ stage, checks: checkMap });

  const chosen = String(formData.get("status") ?? "").trim();
  // A verdict the stage does not allow is refused outright. Quietly falling
  // back to the suggestion would file a record saying something the inspector
  // did not choose.
  if (chosen !== "" && !stageDef(stage).outcomes.includes(chosen as Status))
    return { ok: false, error: "حالة غير مسموح بها في هذه المرحلة." };
  const status: Status = chosen === "" ? suggestion.suggested : (chosen as Status);

  const auth = await requirePermission(verdictPermission(status, suggestion.suggested));
  if (!auth.ok) return auth;

  const inspectionRef = inspections().doc();
  await db().runTransaction(async (tx) => {
    tx.create(inspectionRef, {
      stage,
      partId: null,
      lotId,
      inspectorUid: auth.user.uid,
      inspector,
      inspectedAt: now(),
      status,
      notes: optionalString(formData.get("notes")),
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
      subject: lot.lotNumber,
      partNumber: material?.partNumber ?? "—",
      hasFailedMeasurement: false,
    } satisfies InspectionDoc);

    // A lot mirrors its receiving verdict; PENDING keeps it in the queue.
    tx.update(lots().doc(lotId), { status: status === "PENDING" ? "PENDING" : status });
    tx.update(users().doc(auth.user.uid), { signedInspections: FieldValue.increment(1) });
    tallyFailures(tx, stage, checks);
  });

  revalidatePath(`/lots/${lotId}`);
  revalidatePath("/lots");
  revalidatePath("/");
  return { ok: true, info: `تم تسجيل الفحص — الحالة: ${status}.` };
}

export async function submitPartInspection(formData: FormData): Promise<ActionResult> {
  // See `submitLotInspection`: a floor check first, then the verdict-specific
  // one once the verdict is known.
  const entry = await requirePermission("inspection.submit");
  if (!entry.ok) return entry;
  const inspector = entry.user.displayName;

  const partId = optionalString(formData.get("partId"));
  const stageRaw = String(formData.get("stage") ?? "");

  if (!partId) return { ok: false, error: "معرّف الجزء غير صالح." };
  if (!isStage(stageRaw)) return { ok: false, error: "مرحلة غير معروفة." };

  const stage = stageRaw as Stage;
  const def = stageDef(stage);
  if (def.subject !== "PART") return { ok: false, error: "هذه المرحلة ليست مرحلة أجزاء." };

  const partSnap = await parts().doc(partId).get();
  if (!partSnap.exists) return { ok: false, error: "الجزء غير موجود." };
  const part = partSnap.data() as PartDoc;

  const gate = canInspect(part, stage);
  if (!gate.ok) return { ok: false, error: gate.reason };

  const materialSnap = await materials().doc(part.materialId).get();
  if (!materialSnap.exists) return { ok: false, error: "مواصفة الجزء غير موجودة." };
  const material = materialSnap.data() as MaterialDoc;

  const checks = readChecks(stage, formData);
  const checkMap = Object.fromEntries(checks.map((c) => [c.key, c.ok]));

  // Measurements come from the material's feature list for this stage; the
  // nominal and tolerances are copied in so the record reads on its own even
  // after the drawing is revised.
  const features = (material.features ?? []).filter((f) => f.stage === stage);
  const specs: MeasurementSpec[] = features.map((f) => ({
    kind: f.kind,
    nominal: f.nominal,
    tolMinus: f.tolMinus,
    tolPlus: f.tolPlus,
    gdtLimit: f.gdtLimit,
    actual: optionalNumber(formData.get(`actual_${f.id}`)),
    critical: f.critical,
  }));
  const measurements: MeasurementEntry[] = features.map((f, i) => ({
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
          min: material.hardnessMin,
          max: material.hardnessMax,
        }
      : undefined;

  const suggestion = rollup({ stage, checks: checkMap, measurements: specs, hardness });

  const chosen = String(formData.get("status") ?? "").trim();
  // A verdict the stage does not allow is refused outright rather than quietly
  // replaced by the suggestion — see `submitLotInspection`.
  if (chosen !== "" && !def.outcomes.includes(chosen as Status))
    return { ok: false, error: "حالة غير مسموح بها في هذه المرحلة." };
  const status: Status = chosen === "" ? suggestion.suggested : (chosen as Status);

  // Releasing product needs its own authority; departing from the derived
  // verdict needs another. Agreeing with it needs neither.
  const auth = await requirePermission(verdictPermission(status, suggestion.suggested));
  if (!auth.ok) return auth;

  // PENDING means "sheet not finished" — the part must not move.
  const transition =
    status === "PENDING"
      ? { stage: part.currentStage as Stage, status: part.status as "IN_PROCESS" }
      : nextPartState(stage, status);

  const inspectionRef = inspections().doc();
  await db().runTransaction(async (tx) => {
    tx.create(inspectionRef, {
      stage,
      partId,
      lotId: part.lotId,
      inspectorUid: auth.user.uid,
      inspector,
      inspectedAt: now(),
      status,
      notes: optionalString(formData.get("notes")),
      hardnessValue: hardness?.value ?? null,
      hardnessUnit: stage === "HEAT_TREATMENT" ? material.hardnessUnit : null,
      hardnessMin: stage === "HEAT_TREATMENT" ? material.hardnessMin : null,
      hardnessMax: stage === "HEAT_TREATMENT" ? material.hardnessMax : null,
      surfaceFinishRa: stage === "FINAL" ? optionalNumber(formData.get("surfaceFinishRa")) : null,
      cmmRequired: stage === "FINAL" && formData.get("cmmRequired") === "on",
      cmmReportRef: stage === "FINAL" ? optionalString(formData.get("cmmReportRef")) : null,
      cmmReviewed: stage === "FINAL" && formData.get("cmmReviewed") === "on",
      checks,
      measurements,
      subject: part.serialNumber,
      partNumber: material.partNumber,
      hasFailedMeasurement: measurements.some((m) => m.result === "FAIL"),
    } satisfies InspectionDoc);

    tx.update(parts().doc(partId), {
      currentStage: transition.stage,
      status: transition.status,
      updatedAt: now(),
    });

    tx.create(eventsOf(partId).doc(), {
      at: now(),
      kind: "INSPECTION",
      stage,
      fromValue: `${part.currentStage}/${part.status}`,
      toValue: `${transition.stage}/${transition.status}`,
      note: `${def.ar} — ${status}`,
      actorUid: auth.user.uid,
      actor: inspector,
    });

    tx.update(users().doc(auth.user.uid), { signedInspections: FieldValue.increment(1) });
    tallyFailures(tx, stage, checks);
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

/** How many parts one write batch carries.
 *
 *  Each part costs three writes: the part, its first event, and the serial
 *  reservation. Firestore caps a batch at 500 operations, so 150 parts leaves
 *  room to spare. Batches commit one after another, and each is atomic on its
 *  own — so a failure part-way leaves the earlier batches committed, and the
 *  next attempt continues from the serial the count has reached rather than
 *  colliding with what already exists.
 */
const PARTS_PER_BATCH = 150;

export async function raiseParts(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("part.raise");
  if (!auth.ok) return auth;

  const lotId = optionalString(formData.get("lotId"));
  const count = optionalNumber(formData.get("count"));
  const prefix = String(formData.get("prefix") ?? "").trim();

  if (!lotId) return { ok: false, error: "معرّف التشغيلة غير صالح." };
  if (count == null || count < 1 || count > 500)
    return { ok: false, error: "العدد يجب أن يكون بين 1 و 500." };
  if (!prefix) return { ok: false, error: "بادئة الرقم المسلسل مطلوبة." };

  const lotSnap = await lots().doc(lotId).get();
  if (!lotSnap.exists) return { ok: false, error: "التشغيلة غير موجودة." };
  const lot = lotSnap.data() as LotDoc;

  // `canRaiseParts` wants the verdicts themselves; the lot keeps a tally of
  // them, which is enough to answer "is any analysis rejected".
  const counts = lot.analysisCounts ?? { total: 0, pending: 0, accepted: 0, rejected: 0 };
  const gate = canRaiseParts({
    status: lot.status,
    analyses: [
      ...Array.from({ length: counts.rejected }, () => ({ status: "REJECTED" })),
      ...Array.from({ length: counts.pending }, () => ({ status: "PENDING" })),
      ...Array.from({ length: counts.accepted }, () => ({ status: "ACCEPTED" })),
    ],
  });
  if (!gate.ok) return { ok: false, error: gate.reason };

  const existing = lot.partCount ?? 0;
  const total = Math.trunc(count);
  const serials = Array.from(
    { length: total },
    (_, i) => `${prefix}-${String(existing + i + 1).padStart(4, "0")}`
  );

  let created = 0;
  try {
    for (let offset = 0; offset < serials.length; offset += PARTS_PER_BATCH) {
      const slice = serials.slice(offset, offset + PARTS_PER_BATCH);
      const batch = db().batch();

      for (const serialNumber of slice) {
        const partRef = parts().doc();
        // `create` on the reservation is what enforces the serial: if another
        // writer already holds it the whole batch fails rather than filing a
        // duplicate traveller.
        batch.create(uniques().doc(uniqueKey("part.serialNumber", serialNumber)), {
          scope: "part.serialNumber",
          value: serialNumber,
          ownerPath: partRef.path,
          at: now(),
        });
        batch.create(partRef, {
          serialNumber,
          materialId: lot.materialId,
          lotId,
          batchQty: 1,
          currentStage: "POST_ROUGHING",
          status: "IN_PROCESS",
          createdAt: now(),
          updatedAt: now(),
        } satisfies PartDoc);
        batch.create(eventsOf(partRef.id).doc(), {
          at: now(),
          kind: "CREATED",
          stage: "POST_ROUGHING",
          fromValue: null,
          toValue: "POST_ROUGHING/IN_PROCESS",
          note: `صدر من التشغيلة ${lot.lotNumber}`,
          actorUid: auth.user.uid,
          actor: auth.user.displayName,
        });
      }

      await batch.commit();
      created += slice.length;
    }
  } catch {
    if (created > 0) {
      await bumpPartCounts(lotId, lot.materialId, created);
      revalidatePath(`/lots/${lotId}`);
      revalidatePath("/parts");
      revalidatePath("/queue");
      return {
        ok: false,
        error: `تم إصدار ${created} جزء ثم تعذّر إكمال الباقي — على الأرجح رقم مسلسل مستخدم. أعد المحاولة بالعدد الناقص.`,
      };
    }
    return { ok: false, error: "تعذّر إصدار الأجزاء — على الأرجح رقم مسلسل مستخدم بالفعل." };
  }

  await bumpPartCounts(lotId, lot.materialId, created);

  revalidatePath(`/lots/${lotId}`);
  revalidatePath("/parts");
  revalidatePath("/queue");
  return { ok: true, info: `تم إصدار ${created} جزء.` };
}

/** Keep the lot's and the material's part tallies in step with what was
 *  actually written, including after a partial failure. */
async function bumpPartCounts(lotId: string, materialId: string, by: number): Promise<void> {
  if (by <= 0) return;
  const batch = db().batch();
  batch.update(lots().doc(lotId), { partCount: FieldValue.increment(by) });
  batch.update(materials().doc(materialId), { partCount: FieldValue.increment(by) });
  await batch.commit();
}

/** Send a reworked part back into its queue once the shop has redone it. */
export async function returnPartToQueue(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("part.requeue");
  if (!auth.ok) return auth;

  const partId = optionalString(formData.get("partId"));
  if (!partId) return { ok: false, error: "معرّف غير صالح." };

  const ref = parts().doc(partId);
  try {
    await db().runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      if (!snapshot.exists) throw new Error("NOT_FOUND");

      const part = snapshot.data() as PartDoc;
      if (part.status !== "REWORK" && part.status !== "HOLD") throw new Error("NOT_REWORK");

      tx.update(ref, { status: "IN_PROCESS", updatedAt: now() });
      tx.create(eventsOf(partId).doc(), {
        at: now(),
        kind: "STATUS_CHANGE",
        stage: part.currentStage,
        fromValue: part.status,
        toValue: "IN_PROCESS",
        note: "أُعيد إلى طابور الفحص بعد المعالجة",
        actorUid: auth.user.uid,
        actor: auth.user.displayName,
      });
    });
  } catch (error) {
    const message = (error as Error).message;
    if (message === "NOT_FOUND") return { ok: false, error: "الجزء غير موجود." };
    if (message === "NOT_REWORK")
      return { ok: false, error: "هذا الجزء ليس في إعادة تشغيل أو إيقاف." };
    throw error;
  }

  revalidatePath(`/parts/${partId}`);
  revalidatePath("/queue");
  return { ok: true, info: "تمت إعادة الجزء إلى الطابور." };
}
