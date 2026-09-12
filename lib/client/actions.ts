"use client";

import {
  Timestamp,
  doc,
  getDoc,
  increment,
  query,
  runTransaction,
  setDoc,
  where,
  writeBatch,
  type Transaction,
} from "firebase/firestore";

import {
  canInspect,
  canRaiseParts,
  measurementResult,
  nextPartState,
  rollup,
  type MeasurementSpec,
} from "@/lib/domain/inspection";
import { can, verdictPermission, type Permission } from "@/lib/domain/roles";
import { isStage, stageDef, type Stage, type Status } from "@/lib/domain/stages";
import { optionalNumber, optionalString, triState } from "@/lib/format";
import {
  uniqueKey,
  type AnalysisDoc,
  type AnalysisResultEntry,
  type CertificateEntry,
  type FeatureEntry,
  type InspectionDoc,
  type LotDoc,
  type MaterialDoc,
  type MeasurementEntry,
  type PartDoc,
  type UniqueScope,
  PHOTO_MAX_PER_INSPECTION,
  type InspectionPhotoDoc,
  type InspectionPhotoDataDoc,
} from "@/lib/model";
import { clientDb } from "@/lib/client/firebase";
import {
  analysesOf,
  docIn,
  eventsOf,
  inspections,
  lots,
  materials,
  newId,
  parts,
  stats,
  suppliers,
  uniques,
  userAuditEvents,
  users,
  photosOf,
  photoDataOf,
} from "@/lib/client/db";
import { prepare } from "@/lib/client/photos";
import type { SessionUser } from "@/lib/client/session";

export interface ActionResult {
  ok: boolean;
  error?: string;
  info?: string;
}

/** Writing the quality data, from the browser.
 *
 *  ## Where the boundary actually is
 *
 *  Every permission check in this file runs on the operator's own machine and
 *  could be edited out of the bundle. They are here so somebody is told "you
 *  cannot do that" in Arabic instead of watching a write fail with a Firestore
 *  error — they are courtesy, not control.
 *
 *  The control is `firestore.rules`, which runs on Google's side and re-reads
 *  the account's role for every single operation. Read the note at the top of
 *  that file before changing anything here: it also records the one guarantee
 *  that does not survive without a server, and what catches it instead.
 *
 *  ## Uniqueness and counters
 *
 *  A part number is reserved by creating a document whose id *is* the value.
 *  Firestore refuses to create one that exists and the rules forbid
 *  overwriting one, so two writers racing for the same number still produce
 *  exactly one winner. Counters that reports read are incremented in the same
 *  transaction as the record they describe, so they cannot drift apart.
 */

const now = () => Timestamp.now();

/** The interface's own check, before the rules get a chance to refuse. */
function allow(actor: SessionUser, permission: Permission): ActionResult | null {
  if (!can(actor.role, permission))
    return { ok: false, error: "ليس لديك صلاحية لتنفيذ هذا الإجراء." };
  return null;
}

/** Turn a rules rejection into something an operator can act on. */
function explain(error: unknown, fallback: string): ActionResult {
  const code = (error as { code?: string }).code ?? "";
  if (code.includes("permission-denied"))
    return { ok: false, error: "رفض النظام هذه العملية — راجع صلاحيتك أو حالة السجل." };
  if (code.includes("already-exists")) return { ok: false, error: fallback };
  if (code.includes("unavailable"))
    return { ok: false, error: "تعذّر الوصول إلى قاعدة البيانات. تحقّق من الاتصال." };
  return { ok: false, error: fallback };
}

/** Claim a value inside a transaction, or say who already holds it. */
async function reserveUnique(
  tx: Transaction,
  scope: UniqueScope,
  value: string,
  ownerPath: string
): Promise<boolean> {
  const ref = doc(uniques(), uniqueKey(scope, value));
  const existing = await tx.get(ref);

  if (existing.exists()) {
    return (existing.data() as { ownerPath?: string }).ownerPath === ownerPath;
  }

  tx.set(ref, { scope, value: value.trim(), ownerPath, at: now() });
  return true;
}

function releaseUnique(tx: Transaction, scope: UniqueScope, value: string): void {
  tx.delete(doc(uniques(), uniqueKey(scope, value)));
}

function clashMessage(what: string, value: string): string {
  return `${what} ${value} مسجل بالفعل.`;
}

/** Read the tri-state answers for a stage out of the posted form. */
function readChecks(stage: Stage, formData: FormData) {
  return stageDef(stage).items.map((item) => ({
    key: item.key,
    ok: triState(formData.get(`check_${item.key}`)),
    note: optionalString(formData.get(`note_${item.key}`)),
  }));
}

/** The per-line failure tally the reports page reads, incremented alongside
 *  the inspection that caused it. */
function tallyFailures(
  tx: Transaction,
  stage: Stage,
  checks: { key: string; ok: boolean | null }[]
): void {
  const failed = checks.filter((c) => c.ok === false);
  if (failed.length === 0) return;

  const counts = Object.fromEntries(
    failed.map((check) => [`${stage}::${check.key}`, increment(1)])
  );
  tx.set(doc(stats(), "failures"), { counts }, { merge: true });
}

// ───────────────────────── catalog ─────────────────────────

export const saveMaterial =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "material.manage");
    if (denied) return denied;

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

    const ref = docIn(materials(), id ?? undefined);

    try {
      await runTransaction(clientDb(), async (tx) => {
        const existing = id ? await tx.get(ref) : null;
        if (id && !existing?.exists()) throw new Error("NOT_FOUND");
        const previous = existing?.data() as MaterialDoc | undefined;

        // Reads before writes, which Firestore requires, so the reservation is
        // taken while the transaction can still see a competing one.
        if (!(await reserveUnique(tx, "material.partNumber", partNumber, ref.path)))
          throw new Error("CLASH");

        if (previous && previous.partNumber !== partNumber)
          releaseUnique(tx, "material.partNumber", previous.partNumber);

        if (previous) tx.update(ref, data);
        else tx.set(ref, { ...data, createdAt: now(), features: [], lotCount: 0, partCount: 0 });
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message === "CLASH") return { ok: false, error: clashMessage("رقم الجزء", partNumber) };
      if (message === "NOT_FOUND") return { ok: false, error: "المواصفة غير موجودة." };
      return explain(error, "تعذّر حفظ المواصفة.");
    }

    return { ok: true, info: "تم حفظ المواصفة." };
  };

export const addFeature =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "material.manage");
    if (denied) return denied;

    const materialId = optionalString(formData.get("materialId"));
    const stage = String(formData.get("stage") ?? "").trim();
    const name = String(formData.get("name") ?? "").trim();
    if (!materialId) return { ok: false, error: "معرّف المواصفة غير صالح." };
    if (!name) return { ok: false, error: "اسم الخاصية مطلوب." };
    if (!isStage(stage)) return { ok: false, error: "مرحلة غير معروفة." };

    const ref = docIn(materials(), materialId);
    try {
      await runTransaction(clientDb(), async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists()) throw new Error("NOT_FOUND");

        const features = (snapshot.data() as MaterialDoc).features ?? [];
        const feature: FeatureEntry = {
          id: newId(),
          stage,
          name,
          kind: String(formData.get("kind") ?? "DIMENSION") === "GDT" ? "GDT" : "DIMENSION",
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
      return explain(error, "تعذّر إضافة الخاصية.");
    }

    return { ok: true, info: "تمت إضافة الخاصية." };
  };

export const deleteFeature =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "material.manage");
    if (denied) return denied;

    const materialId = optionalString(formData.get("materialId"));
    const featureId = optionalString(formData.get("id"));
    if (!materialId || !featureId) return { ok: false, error: "معرّف غير صالح." };

    const ref = docIn(materials(), materialId);
    try {
      await runTransaction(clientDb(), async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists()) return;
        const features = (snapshot.data() as MaterialDoc).features ?? [];
        tx.update(ref, { features: features.filter((f) => f.id !== featureId) });
      });
    } catch (error) {
      return explain(error, "تعذّر حذف الخاصية.");
    }

    return { ok: true, info: "تم حذف الخاصية." };
  };

export const saveSupplier =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "supplier.manage");
    if (denied) return denied;

    const name = String(formData.get("name") ?? "").trim();
    if (!name) return { ok: false, error: "اسم المورد مطلوب." };

    const id = optionalString(formData.get("id"));
    const data = {
      name,
      code: optionalString(formData.get("code")),
      contact: optionalString(formData.get("contact")),
      notes: optionalString(formData.get("notes")),
    };
    const ref = docIn(suppliers(), id ?? undefined);

    try {
      await runTransaction(clientDb(), async (tx) => {
        const existing = id ? await tx.get(ref) : null;
        const previous = existing?.data() as { name: string } | undefined;

        if (!(await reserveUnique(tx, "supplier.name", name, ref.path))) throw new Error("CLASH");
        if (previous && previous.name !== name) releaseUnique(tx, "supplier.name", previous.name);

        if (previous) tx.update(ref, data);
        else tx.set(ref, { ...data, createdAt: now() });
      });
    } catch (error) {
      if ((error as Error).message === "CLASH")
        return { ok: false, error: clashMessage("اسم المورد", name) };
      return explain(error, "تعذّر حفظ المورد.");
    }

    return { ok: true, info: "تم حفظ المورد." };
  };

// ───────────────────── raw material receiving ─────────────────────

export const receiveLot =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "lot.receive");
    if (denied) return denied;

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

    const ref = docIn(lots());
    try {
      await runTransaction(clientDb(), async (tx) => {
        const materialRef = docIn(materials(), materialId);
        const materialSnap = await tx.get(materialRef);
        if (!materialSnap.exists()) throw new Error("NO_MATERIAL");

        if (!(await reserveUnique(tx, "lot.lotNumber", lotNumber, ref.path)))
          throw new Error("CLASH");

        tx.set(ref, {
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
        });
        tx.update(materialRef, { lotCount: increment(1) });
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message === "CLASH") return { ok: false, error: clashMessage("رقم التشغيلة", lotNumber) };
      if (message === "NO_MATERIAL") return { ok: false, error: "المواصفة غير موجودة." };
      return explain(error, "تعذّر تسجيل الاستلام.");
    }

    return { ok: true, info: `تم تسجيل استلام التشغيلة ${lotNumber}.`, };
  };

export const addCertificate =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "lot.certificate.manage");
    if (denied) return denied;

    const lotId = optionalString(formData.get("lotId"));
    const type = String(formData.get("type") ?? "").trim();
    if (!lotId) return { ok: false, error: "معرّف التشغيلة غير صالح." };
    if (!type) return { ok: false, error: "نوع الشهادة مطلوب." };

    const issuedAtRaw = optionalString(formData.get("issuedAt"));
    const issuedAt = issuedAtRaw ? new Date(issuedAtRaw) : null;
    if (issuedAt && Number.isNaN(issuedAt.getTime()))
      return { ok: false, error: "تاريخ الإصدار غير صالح." };

    const ref = docIn(lots(), lotId);
    try {
      await runTransaction(clientDb(), async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists()) throw new Error("NOT_FOUND");

        const certificate: CertificateEntry = {
          id: newId(),
          type,
          number: optionalString(formData.get("number")),
          issuedAt: issuedAt ? Timestamp.fromDate(issuedAt) : null,
          received: formData.get("received") === "on",
          verified: formData.get("verified") === "on",
          notes: optionalString(formData.get("notes")),
        };
        tx.update(ref, {
          certificates: [...((snapshot.data() as LotDoc).certificates ?? []), certificate],
        });
      });
    } catch (error) {
      if ((error as Error).message === "NOT_FOUND")
        return { ok: false, error: "التشغيلة غير موجودة." };
      return explain(error, "تعذّر إضافة الشهادة.");
    }

    return { ok: true, info: "تمت إضافة الشهادة." };
  };

export const setCertificate =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "lot.certificate.manage");
    if (denied) return denied;

    const lotId = optionalString(formData.get("lotId"));
    const certificateId = optionalString(formData.get("id"));
    if (!lotId || !certificateId) return { ok: false, error: "معرّف غير صالح." };

    const ref = docIn(lots(), lotId);
    try {
      await runTransaction(clientDb(), async (tx) => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists()) return;
        tx.update(ref, {
          certificates: ((snapshot.data() as LotDoc).certificates ?? []).map((c) =>
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
    } catch (error) {
      return explain(error, "تعذّر تحديث الشهادة.");
    }

    return { ok: true, info: "تم تحديث الشهادة." };
  };

// ───────────────────── raw material analysis ─────────────────────

export const createAnalysis =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "analysis.record");
    if (denied) return denied;

    const lotId = optionalString(formData.get("lotId"));
    const sampleRef = String(formData.get("sampleRef") ?? "").trim();
    if (!lotId || !sampleRef) return { ok: false, error: "مرجع العينة مطلوب." };

    // Chemistry lines the lab fills in. Kept as free rows so a different alloy
    // can be analysed without a schema change.
    const properties = formData.getAll("property").map((v) => String(v).trim());
    const mins = formData.getAll("requiredMin");
    const maxes = formData.getAll("requiredMax");
    const units = formData.getAll("unit");

    const results: AnalysisResultEntry[] = properties
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

    try {
      const batch = writeBatch(clientDb());
      batch.set(docIn(analysesOf(lotId)), {
        sampleRef,
        method: optionalString(formData.get("method")),
        performedAt: now(),
        // Who ran the test may be an outside laboratory; who is answerable for
        // the record is always the account that entered it.
        performedBy: optionalString(formData.get("performedBy")),
        recordedByUid: actor.uid,
        recordedByName: actor.displayName,
        status: "PENDING",
        conclusion: null,
        actionTaken: null,
        results,
      });
      batch.update(docIn(lots(), lotId), {
        "analysisCounts.total": increment(1),
        "analysisCounts.pending": increment(1),
      });
      await batch.commit();
    } catch (error) {
      return explain(error, "تعذّر فتح التحليل.");
    }

    return { ok: true, info: "تم فتح تحليل جديد." };
  };

export const saveAnalysisResults =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "analysis.record");
    if (denied) return denied;

    const lotId = optionalString(formData.get("lotId"));
    const analysisId = optionalString(formData.get("analysisId"));
    if (!lotId || !analysisId) return { ok: false, error: "معرّف غير صالح." };

    const { analysisStatus } = await import("@/lib/domain/inspection");
    let status: Status = "PENDING";

    try {
      await runTransaction(clientDb(), async (tx) => {
        const analysisRef = docIn(analysesOf(lotId), analysisId);
        const lotRef = docIn(lots(), lotId);
        const [analysisSnap, lotSnap] = await Promise.all([tx.get(analysisRef), tx.get(lotRef)]);
        if (!analysisSnap.exists() || !lotSnap.exists()) throw new Error("NOT_FOUND");

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
            [`analysisCounts.${bucket(previous)}`]: increment(-1),
            [`analysisCounts.${bucket(status)}`]: increment(1),
          });
        }
      });
    } catch (error) {
      if ((error as Error).message === "NOT_FOUND")
        return { ok: false, error: "التحليل غير موجود." };
      return explain(error, "تعذّر حفظ النتائج.");
    }

    return { ok: true, info: `تم حفظ النتائج — الحالة: ${status}.` };
  };

// ─────────────── the checklist submit path ───────────────

export const submitLotInspection =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "inspection.submit");
    if (denied) return denied;

    const lotId = optionalString(formData.get("lotId"));
    if (!lotId) return { ok: false, error: "معرّف التشغيلة غير صالح." };

    const lotSnap = await getDoc(docIn(lots(), lotId));
    if (!lotSnap.exists()) return { ok: false, error: "التشغيلة غير موجودة." };
    const lot = lotSnap.data() as LotDoc;

    const materialSnap = await getDoc(docIn(materials(), lot.materialId));
    const material = materialSnap.data() as MaterialDoc | undefined;

    const stage: Stage = "RAW_RECEIVING";
    const checks = readChecks(stage, formData);
    const suggestion = rollup({
      stage,
      checks: Object.fromEntries(checks.map((c) => [c.key, c.ok])),
    });

    const chosen = String(formData.get("status") ?? "").trim();
    // A verdict the stage does not allow is refused outright. Quietly falling
    // back to the suggestion would file a record saying something the
    // inspector did not choose.
    if (chosen !== "" && !stageDef(stage).outcomes.includes(chosen as Status))
      return { ok: false, error: "حالة غير مسموح بها في هذه المرحلة." };
    const status: Status = chosen === "" ? suggestion.suggested : (chosen as Status);

    const verdictDenied = allow(actor, verdictPermission(status, suggestion.suggested));
    if (verdictDenied) return verdictDenied;

    try {
      await runTransaction(clientDb(), async (tx) => {
        tx.set(docIn(inspections()), {
          stage,
          partId: null,
          lotId,
          // The rules require this to equal the caller's own uid, so a forged
          // signature is refused by the database rather than by this line.
          inspectorUid: actor.uid,
          inspector: actor.displayName,
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
        tx.update(docIn(lots(), lotId), { status: status === "PENDING" ? "PENDING" : status });
        tx.update(docIn(users(), actor.uid), { signedInspections: increment(1) });
        tallyFailures(tx, stage, checks);
      });
    } catch (error) {
      return explain(error, "تعذّر تسجيل الفحص.");
    }

    return { ok: true, info: `تم تسجيل الفحص — الحالة: ${status}.` };
  };


/** The defect photographs posted with an inspection, resized and encoded.
 *
 *  Done before the transaction opens, not inside it. A transaction callback is
 *  re-run whenever Firestore sees contention, and re-compressing four
 *  photographs on a tablet each time it retries is how a sheet takes half a
 *  minute to save. It also means a picture that cannot be read fails the sheet
 *  with a plain sentence rather than half-writing it.
 */
async function readPhotos(formData: FormData) {
  const files = formData
    .getAll("photos")
    .filter((f): f is File => f instanceof File && f.size > 0);

  if (files.length > PHOTO_MAX_PER_INSPECTION)
    throw new Error(`الحد ${PHOTO_MAX_PER_INSPECTION} صور للفحص الواحد.`);

  return Promise.all(files.map((file) => prepare(file)));
}

export const submitPartInspection =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "inspection.submit");
    if (denied) return denied;

    const partId = optionalString(formData.get("partId"));
    const stageRaw = String(formData.get("stage") ?? "");
    if (!partId) return { ok: false, error: "معرّف الجزء غير صالح." };
    if (!isStage(stageRaw)) return { ok: false, error: "مرحلة غير معروفة." };

    const stage = stageRaw as Stage;
    const def = stageDef(stage);
    if (def.subject !== "PART") return { ok: false, error: "هذه المرحلة ليست مرحلة أجزاء." };

    const partSnap = await getDoc(docIn(parts(), partId));
    if (!partSnap.exists()) return { ok: false, error: "الجزء غير موجود." };
    const part = partSnap.data() as PartDoc;

    const gate = canInspect(part, stage);
    if (!gate.ok) return { ok: false, error: gate.reason };

    const materialSnap = await getDoc(docIn(materials(), part.materialId));
    if (!materialSnap.exists()) return { ok: false, error: "مواصفة الجزء غير موجودة." };
    const material = materialSnap.data() as MaterialDoc;

    const checks = readChecks(stage, formData);

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

    const suggestion = rollup({
      stage,
      checks: Object.fromEntries(checks.map((c) => [c.key, c.ok])),
      measurements: specs,
      hardness,
    });

    const chosen = String(formData.get("status") ?? "").trim();
    if (chosen !== "" && !def.outcomes.includes(chosen as Status))
      return { ok: false, error: "حالة غير مسموح بها في هذه المرحلة." };
    const status: Status = chosen === "" ? suggestion.suggested : (chosen as Status);

    // Releasing product needs its own authority; departing from the derived
    // verdict needs another. Agreeing with it needs neither. The release half
    // of this is also enforced by the rules; the override half cannot be,
    // which is what the reconciliation report exists for.
    const verdictDenied = allow(actor, verdictPermission(status, suggestion.suggested));
    if (verdictDenied) return verdictDenied;

    // PENDING means "sheet not finished" — the part must not move.
    const transition =
      status === "PENDING"
        ? { stage: part.currentStage as Stage, status: part.status as "IN_PROCESS" }
        : nextPartState(stage, status);

    let photos;
    try {
      photos = await readPhotos(formData);
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? "تعذّرت معالجة الصور.") };
    }

    try {
      await runTransaction(clientDb(), async (tx) => {
        // Named, because the photographs hang off it.
        const inspectionRef = docIn(inspections());

        tx.set(inspectionRef, {
          stage,
          partId,
          lotId: part.lotId,
          inspectorUid: actor.uid,
          inspector: actor.displayName,
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

        // Evidence and verdict commit together or not at all. A photograph of
        // a defect that outlived the sheet it was taken for would be a
        // photograph of nothing in particular.
        for (const photo of photos) {
          const photoId = docIn(photosOf(inspectionRef.id)).id;

          tx.set(docIn(photosOf(inspectionRef.id), photoId), {
            thumb: photo.thumb,
            caption: null,
            width: photo.width,
            height: photo.height,
            bytes: photo.bytes,
            capturedAt: now(),
            capturedByUid: actor.uid,
            capturedByName: actor.displayName,
          } satisfies InspectionPhotoDoc);

          tx.set(docIn(photoDataOf(inspectionRef.id), photoId), {
            data: photo.data,
          } satisfies InspectionPhotoDataDoc);
        }

        tx.update(docIn(parts(), partId), {
          currentStage: transition.stage,
          status: transition.status,
          updatedAt: now(),
        });

        tx.set(docIn(eventsOf(partId)), {
          at: now(),
          kind: "INSPECTION",
          stage,
          fromValue: `${part.currentStage}/${part.status}`,
          toValue: `${transition.stage}/${transition.status}`,
          note: `${def.ar} — ${status}`,
          actorUid: actor.uid,
          actor: actor.displayName,
        });

        tx.update(docIn(users(), actor.uid), { signedInspections: increment(1) });
        tallyFailures(tx, stage, checks);
      });
    } catch (error) {
      return explain(error, "تعذّر تسجيل الفحص.");
    }

    return {
      ok: true,
      info: `تم تسجيل الفحص — الحالة: ${status}. الجزء الآن في: ${transition.stage}.`,
    };
  };

// ───────────────────────── parts ─────────────────────────

/** Each part costs three writes: the part, its first event, and the serial
 *  reservation. Firestore caps a batch at five hundred operations, so a
 *  hundred and fifty leaves room to spare. */
const PARTS_PER_BATCH = 150;

export const raiseParts =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "part.raise");
    if (denied) return denied;

    const lotId = optionalString(formData.get("lotId"));
    const count = optionalNumber(formData.get("count"));
    const prefix = String(formData.get("prefix") ?? "").trim();

    if (!lotId) return { ok: false, error: "معرّف التشغيلة غير صالح." };
    if (count == null || count < 1 || count > 500)
      return { ok: false, error: "العدد يجب أن يكون بين 1 و 500." };
    if (!prefix) return { ok: false, error: "بادئة الرقم المسلسل مطلوبة." };

    const lotSnap = await getDoc(docIn(lots(), lotId));
    if (!lotSnap.exists()) return { ok: false, error: "التشغيلة غير موجودة." };
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
    const serials = Array.from(
      { length: Math.trunc(count) },
      (_, i) => `${prefix}-${String(existing + i + 1).padStart(4, "0")}`
    );

    let created = 0;
    try {
      for (let offset = 0; offset < serials.length; offset += PARTS_PER_BATCH) {
        const slice = serials.slice(offset, offset + PARTS_PER_BATCH);
        const batch = writeBatch(clientDb());

        for (const serialNumber of slice) {
          const partRef = docIn(parts());
          // The reservation is what enforces the serial: the rules forbid
          // overwriting one, so a clash fails the whole batch rather than
          // filing a duplicate traveller.
          batch.set(doc(uniques(), uniqueKey("part.serialNumber", serialNumber)), {
            scope: "part.serialNumber",
            value: serialNumber,
            ownerPath: partRef.path,
            at: now(),
          });
          batch.set(partRef, {
            serialNumber,
            materialId: lot.materialId,
            lotId,
            batchQty: 1,
            currentStage: "POST_ROUGHING",
            status: "IN_PROCESS",
            createdAt: now(),
            updatedAt: now(),
          } satisfies PartDoc);
          batch.set(docIn(eventsOf(partRef.id)), {
            at: now(),
            kind: "CREATED",
            stage: "POST_ROUGHING",
            fromValue: null,
            toValue: "POST_ROUGHING/IN_PROCESS",
            note: `صدر من التشغيلة ${lot.lotNumber}`,
            actorUid: actor.uid,
            actor: actor.displayName,
          });
        }

        await batch.commit();
        created += slice.length;
      }
    } catch (error) {
      if (created > 0) {
        await bumpPartCounts(lotId, lot.materialId, created);
        return {
          ok: false,
          error: `تم إصدار ${created} جزء ثم تعذّر إكمال الباقي — على الأرجح رقم مسلسل مستخدم. أعد المحاولة بالعدد الناقص.`,
        };
      }
      return explain(error, "تعذّر إصدار الأجزاء — على الأرجح رقم مسلسل مستخدم بالفعل.");
    }

    await bumpPartCounts(lotId, lot.materialId, created);
    return { ok: true, info: `تم إصدار ${created} جزء.` };
  };

/** Keep the lot's and the material's part tallies in step with what was
 *  actually written, including after a partial failure. */
async function bumpPartCounts(lotId: string, materialId: string, by: number): Promise<void> {
  if (by <= 0) return;
  const batch = writeBatch(clientDb());
  batch.update(docIn(lots(), lotId), { partCount: increment(by) });
  batch.update(docIn(materials(), materialId), { partCount: increment(by) });
  await batch.commit();
}

export const returnPartToQueue =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "part.requeue");
    if (denied) return denied;

    const partId = optionalString(formData.get("partId"));
    if (!partId) return { ok: false, error: "معرّف غير صالح." };

    try {
      await runTransaction(clientDb(), async (tx) => {
        const ref = docIn(parts(), partId);
        const snapshot = await tx.get(ref);
        if (!snapshot.exists()) throw new Error("NOT_FOUND");

        const part = snapshot.data() as PartDoc;
        if (part.status !== "REWORK" && part.status !== "HOLD") throw new Error("NOT_REWORK");

        tx.update(ref, { status: "IN_PROCESS", updatedAt: now() });
        tx.set(docIn(eventsOf(partId)), {
          at: now(),
          kind: "STATUS_CHANGE",
          stage: part.currentStage,
          fromValue: part.status,
          toValue: "IN_PROCESS",
          note: "أُعيد إلى طابور الفحص بعد المعالجة",
          actorUid: actor.uid,
          actor: actor.displayName,
        });
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message === "NOT_FOUND") return { ok: false, error: "الجزء غير موجود." };
      if (message === "NOT_REWORK")
        return { ok: false, error: "هذا الجزء ليس في إعادة تشغيل أو إيقاف." };
      return explain(error, "تعذّرت إعادة الجزء.");
    }

    return { ok: true, info: "تمت إعادة الجزء إلى الطابور." };
  };

// ───────────────────────── accounts ─────────────────────────

/** Account administration, minus the one thing a browser cannot do.
 *
 *  Creating a Firebase Authentication account needs the Admin SDK, which needs
 *  a service-account key, which cannot live in a browser bundle. So on this
 *  plan an administrator creates the sign-in credential in the Firebase
 *  console and then grants it a role here. `npm run create-admin` does both at
 *  once for anyone who has a key to run it with.
 */
export const grantAccess =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "user.manage");
    if (denied) return denied;

    const uid = String(formData.get("uid") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const displayName = String(formData.get("displayName") ?? "").trim();
    const role = String(formData.get("role") ?? "").trim();

    if (!uid) return { ok: false, error: "معرّف Firebase (UID) مطلوب — انسخه من Console." };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return { ok: false, error: "البريد الإلكتروني غير صالح." };
    if (!displayName)
      return { ok: false, error: "الاسم مطلوب — هو الاسم الذي يُوقَّع به على الفحوص." };

    const { isRole } = await import("@/lib/domain/roles");
    if (!isRole(role)) return { ok: false, error: "الصلاحية غير معروفة." };
    if (uid === actor.uid)
      return { ok: false, error: "لا يمكنك تعديل حسابك بنفسك. يجب أن يقوم بذلك مدير نظام آخر." };

    try {
      const ref = docIn(users(), uid);
      const existing = await getDoc(ref);
      await setDoc(
        ref,
        {
          email,
          displayName,
          role,
          employeeNo: optionalString(formData.get("employeeNo")),
          active: true,
          createdAt: existing.exists() ? (existing.data() as { createdAt: unknown }).createdAt : now(),
          updatedAt: now(),
          createdByUid: actor.uid,
          createdByName: actor.displayName,
          signedInspections: existing.exists()
            ? ((existing.data() as { signedInspections?: number }).signedInspections ?? 0)
            : 0,
        },
        { merge: true }
      );

      await setDoc(docIn(userAuditEvents()), {
        at: now(),
        kind: existing.exists() ? "ROLE_CHANGED" : "CREATED",
        subjectUid: uid,
        subjectName: displayName,
        actorUid: actor.uid,
        actorName: actor.displayName,
        fromValue: existing.exists() ? ((existing.data() as { role?: string }).role ?? null) : null,
        toValue: role,
      });
    } catch (error) {
      return explain(error, "تعذّر حفظ الحساب.");
    }

    return { ok: true, info: `تم منح ${displayName} صلاحية ${role}.` };
  };

export const setUserRole =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "user.manage");
    if (denied) return denied;

    const uid = optionalString(formData.get("id"));
    const role = String(formData.get("role") ?? "").trim();
    if (!uid) return { ok: false, error: "معرّف غير صالح." };

    const { ROLES, isRole } = await import("@/lib/domain/roles");
    if (!isRole(role)) return { ok: false, error: `الصلاحية يجب أن تكون إحدى: ${ROLES.join(", ")}` };
    if (uid === actor.uid)
      return { ok: false, error: "لا يمكنك تعديل صلاحيتك بنفسك. يجب أن يقوم بذلك مدير نظام آخر." };

    const snapshot = await getDoc(docIn(users(), uid));
    if (!snapshot.exists()) return { ok: false, error: "الحساب غير موجود." };
    const subject = snapshot.data() as { role: string; active: boolean; displayName: string };
    if (subject.role === role) return { ok: true, info: "لا تغيير." };

    if (role !== "ADMIN") {
      const refusal = await lastAdminRefusal(subject);
      if (refusal) return { ok: false, error: refusal };
    }

    try {
      const batch = writeBatch(clientDb());
      batch.update(docIn(users(), uid), { role, updatedAt: now() });
      batch.set(docIn(userAuditEvents()), {
        at: now(),
        kind: "ROLE_CHANGED",
        subjectUid: uid,
        subjectName: subject.displayName,
        actorUid: actor.uid,
        actorName: actor.displayName,
        fromValue: subject.role,
        toValue: role,
      });
      await batch.commit();
    } catch (error) {
      return explain(error, "تعذّر تغيير الصلاحية.");
    }

    return { ok: true, info: `تم تغيير صلاحية ${subject.displayName}.` };
  };

export const setUserActive =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "user.manage");
    if (denied) return denied;

    const uid = optionalString(formData.get("id"));
    const active = formData.get("active") === "true";
    if (!uid) return { ok: false, error: "معرّف غير صالح." };

    const snapshot = await getDoc(docIn(users(), uid));
    if (!snapshot.exists()) return { ok: false, error: "الحساب غير موجود." };
    const subject = snapshot.data() as { role: string; active: boolean; displayName: string };
    if (subject.active === active) return { ok: true, info: "لا تغيير." };

    if (!active) {
      if (uid === actor.uid)
        return { ok: false, error: "لا يمكنك إيقاف حسابك بنفسك. يجب أن يقوم بذلك مدير نظام آخر." };
      const refusal = await lastAdminRefusal(subject);
      if (refusal) return { ok: false, error: refusal };
    }

    try {
      const batch = writeBatch(clientDb());
      batch.update(docIn(users(), uid), { active, updatedAt: now() });
      batch.set(docIn(userAuditEvents()), {
        at: now(),
        kind: active ? "ACTIVATED" : "DEACTIVATED",
        subjectUid: uid,
        subjectName: subject.displayName,
        actorUid: actor.uid,
        actorName: actor.displayName,
        fromValue: String(subject.active),
        toValue: String(active),
      });
      await batch.commit();
    } catch (error) {
      return explain(error, "تعذّر تغيير حالة الحساب.");
    }

    return {
      ok: true,
      info: active
        ? `تم تفعيل ${subject.displayName}.`
        : `تم إيقاف ${subject.displayName}. لن يستطيع الدخول من الطلب التالي.`,
    };
  };

/** Would this change leave nobody able to administer the system?
 *
 *  Stated separately from the self-edit rule even though that rule implies it
 *  today, so the invariant survives a change to it. A count aggregation rather
 *  than a read of the staff list: exact, and one read whatever the headcount.
 */
async function lastAdminRefusal(subject: {
  role: string;
  active: boolean;
}): Promise<string | null> {
  if (subject.role !== "ADMIN" || !subject.active) return null;

  const { getCountFromServer } = await import("firebase/firestore");
  const others = await getCountFromServer(
    query(users(), where("role", "==", "ADMIN"), where("active", "==", true))
  );
  // The subject is still counted here, so "only them" reads as one.
  if (others.data().count <= 1) return "هذا هو مدير النظام النشط الوحيد. عيّن مدير نظام آخر أولًا.";
  return null;
}
