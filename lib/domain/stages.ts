/** Stage definitions, checklist templates and status vocabulary.
 *
 *  This file is the single source of truth for the inspection plan. Every
 *  checklist line below is transcribed from the approved Quality Inspection
 *  Checklist; `key` is what the database stores, the labels are display only,
 *  so re-wording a label never invalidates historical records.
 */

export const STAGES = [
  "RAW_RECEIVING",
  "RAW_ANALYSIS",
  "POST_ROUGHING",
  "HEAT_TREATMENT",
  "POST_GRINDING",
  "FINAL",
] as const;
export type Stage = (typeof STAGES)[number];

export const STATUSES = [
  "PENDING",
  "ACCEPTED",
  "REWORK",
  "REJECTED",
  "FURTHER_INVESTIGATION",
  "RELEASED",
] as const;
export type Status = (typeof STATUSES)[number];

export type CheckKind = "CHECK" | "MEASUREMENTS" | "HARDNESS" | "CMM";

export interface CheckItem {
  key: string;
  ar: string;
  en: string;
  /** Section heading this line sits under (Heat Treatment / Final split). */
  group?: string;
}

export interface StageDef {
  stage: Stage;
  /** 1-based position in the printed checklist. */
  order: number;
  ar: string;
  en: string;
  /** What the record hangs off: a received lot, or a part traveller. */
  subject: "LOT" | "PART";
  /** Verdicts an inspector may pick for this stage. */
  outcomes: readonly Status[];
  /** Stage the part moves to once accepted (part stages only). */
  next?: Stage | "DONE";
  /** Shop-floor operation that happens before this inspection. */
  precedingOperation?: { ar: string; en: string };
  items: readonly CheckItem[];
}

export const STAGE_DEFS: readonly StageDef[] = [
  {
    stage: "RAW_RECEIVING",
    order: 1,
    ar: "استلام الخامات",
    en: "Raw Material Receiving",
    subject: "LOT",
    outcomes: ["ACCEPTED", "REJECTED", "PENDING"],
    items: [
      { key: "receive_from_supplier", ar: "استلام الخامة من المورد", en: "Material received from supplier" },
      { key: "verify_part_number", ar: "التأكد من Part / Material Number", en: "Part / Material Number verified" },
      { key: "review_qty_condition", ar: "مراجعة الكمية وحالة الخامة", en: "Quantity and material condition reviewed" },
      { key: "review_certificates", ar: "مراجعة شهادات الخامة المطلوبة", en: "Required material certificates reviewed" },
      { key: "visual_inspection", ar: "إجراء الفحص الظاهري للخامة", en: "Visual inspection performed" },
      { key: "record_in_sheet", ar: "تسجيل بيانات الخامة في Raw Material Inspection Sheet", en: "Recorded in Raw Material Inspection Sheet" },
    ],
  },
  {
    stage: "RAW_ANALYSIS",
    order: 2,
    ar: "تحليل الخامة",
    en: "Raw Material Analysis",
    subject: "LOT",
    outcomes: ["ACCEPTED", "REJECTED", "PENDING"],
    items: [
      { key: "random_samples", ar: "اختيار عينات عشوائية للتحليل حسب الحاجة", en: "Random samples selected as required" },
      { key: "perform_tests", ar: "إجراء الاختبارات المطلوبة", en: "Required tests performed" },
      { key: "record_results", ar: "تسجيل نتائج التحليل", en: "Analysis results recorded" },
      { key: "compare_to_spec", ar: "مقارنة النتائج بالمواصفات المطلوبة", en: "Results compared against the specification" },
      { key: "corrective_action", ar: "اتخاذ الإجراء المناسب في حالة عدم المطابقة", en: "Corrective action taken on non-conformance" },
    ],
  },
  {
    stage: "POST_ROUGHING",
    order: 3,
    ar: "الفحص بعد الـ Roughing",
    en: "Post-Roughing Inspection",
    subject: "PART",
    outcomes: ["ACCEPTED", "REWORK", "REJECTED"],
    next: "HEAT_TREATMENT",
    precedingOperation: { ar: "الخشونة (Roughing)", en: "Roughing" },
    items: [
      { key: "receive_parts", ar: "استلام الأجزاء بعد انتهاء عملية الـ Roughing", en: "Parts received after roughing" },
      { key: "verify_drawing_number", ar: "مراجعة رقم الجزء / Drawing Number", en: "Part / Drawing Number verified" },
      { key: "check_dimensions", ar: "فحص الأبعاد المطلوبة في هذه المرحلة", en: "Stage dimensions checked" },
      { key: "check_critical_features", ar: "فحص الـ Critical Features", en: "Critical features checked" },
      { key: "allowance_ok", ar: "التأكد من وجود Allowance مناسب للمراحل التالية", en: "Adequate allowance left for later stages" },
      { key: "record_results", ar: "تسجيل نتائج الفحص", en: "Inspection results recorded" },
    ],
  },
  {
    stage: "HEAT_TREATMENT",
    order: 4,
    ar: "الفحص بعد المعالجة الحرارية",
    en: "Heat Treatment Inspection",
    subject: "PART",
    outcomes: ["ACCEPTED", "REJECTED", "FURTHER_INVESTIGATION"],
    next: "POST_GRINDING",
    precedingOperation: { ar: "المعالجة الحرارية (Heat Treatment)", en: "Heat Treatment" },
    items: [
      { key: "visual_after_ht", ar: "فحص الجزء بصريًا بعد المعالجة", en: "Part visually inspected after treatment", group: "VISUAL" },
      { key: "no_cracks", ar: "التأكد من عدم وجود Cracks", en: "No cracks", group: "VISUAL" },
      { key: "no_surface_defects", ar: "التأكد من عدم وجود Surface Defects", en: "No surface defects", group: "VISUAL" },
      { key: "no_warpage", ar: "فحص التشوهات أو الـ Warpage", en: "Distortion / warpage checked", group: "VISUAL" },
      { key: "record_visual", ar: "تسجيل نتيجة الفحص البصري", en: "Visual result recorded", group: "VISUAL" },
      { key: "measure_hardness", ar: "قياس Hardness طبقًا للمواصفة", en: "Hardness measured per specification", group: "HARDNESS" },
      { key: "record_hardness", ar: "تسجيل قيمة Hardness الفعلية", en: "Actual hardness value recorded", group: "HARDNESS" },
      { key: "compare_range", ar: "مقارنة القيمة بالـ Required Range", en: "Value compared against the required range", group: "HARDNESS" },
    ],
  },
  {
    stage: "POST_GRINDING",
    order: 5,
    ar: "الفحص بعد الـ Grinding",
    en: "Post-Grinding Inspection",
    subject: "PART",
    outcomes: ["ACCEPTED", "REWORK", "REJECTED"],
    next: "FINAL",
    precedingOperation: { ar: "التجليخ (Grinding)", en: "Grinding" },
    items: [
      { key: "receive_parts", ar: "استلام الأجزاء بعد التجليخ", en: "Parts received after grinding" },
      { key: "surface_condition", ar: "فحص Surface Condition", en: "Surface condition checked" },
      { key: "no_grinding_marks", ar: "التأكد من عدم وجود Grinding Marks غير مقبولة", en: "No unacceptable grinding marks" },
      { key: "no_grinding_burn", ar: "التأكد من عدم وجود Grinding Burn", en: "No grinding burn" },
      { key: "check_dimensions", ar: "فحص الأبعاد المطلوبة", en: "Required dimensions checked" },
      { key: "check_critical_features", ar: "فحص الـ Critical Features", en: "Critical features checked" },
      { key: "record_results", ar: "تسجيل نتائج القياس", en: "Measurement results recorded" },
    ],
  },
  {
    stage: "FINAL",
    order: 6,
    ar: "الفحص النهائي",
    en: "Final / Finishing Inspection",
    subject: "PART",
    outcomes: ["RELEASED", "REWORK", "REJECTED"],
    next: "DONE",
    precedingOperation: { ar: "التشطيب (Finishing)", en: "Finishing" },
    items: [
      { key: "check_surface_finish", ar: "فحص الـ Surface Finish", en: "Surface finish checked", group: "FINISH" },
      { key: "polish_level", ar: "التأكد من تحقيق مستوى الـ Polish المطلوب", en: "Required polish level achieved", group: "FINISH" },
      { key: "no_scratches", ar: "التأكد من عدم وجود خدوش أو عيوب سطحية", en: "No scratches or surface defects", group: "FINISH" },
      { key: "record_finish", ar: "تسجيل نتيجة فحص الـ Finish", en: "Finish result recorded", group: "FINISH" },
      { key: "final_dimensions", ar: "فحص الأبعاد النهائية طبقًا للـ Drawing", en: "Final dimensions checked against the drawing", group: "DIMENSIONAL" },
      { key: "critical_dimensions", ar: "قياس الـ Critical Dimensions", en: "Critical dimensions measured", group: "DIMENSIONAL" },
      { key: "gdt", ar: "قياس الـ GD&T المطلوبة", en: "Required GD&T measured", group: "DIMENSIONAL" },
      { key: "cmm_measurements", ar: "إجراء قياسات CMM عند الحاجة", en: "CMM measurements taken where required", group: "DIMENSIONAL" },
      { key: "cmm_report_review", ar: "مراجعة تقرير الـ CMM", en: "CMM report reviewed", group: "DIMENSIONAL" },
      { key: "all_features_conform", ar: "التأكد من مطابقة جميع الـ Features للمواصفات", en: "All features conform to specification", group: "DIMENSIONAL" },
    ],
  },
];

const BY_STAGE = new Map<Stage, StageDef>(STAGE_DEFS.map((d) => [d.stage, d]));

export function stageDef(stage: string): StageDef {
  const def = BY_STAGE.get(stage as Stage);
  if (!def) throw new Error(`Unknown stage: ${stage}`);
  return def;
}

export function isStage(value: string): value is Stage {
  return BY_STAGE.has(value as Stage);
}

/** Section headings used inside the two split stages. */
export const GROUP_LABELS: Record<string, { ar: string; en: string }> = {
  VISUAL: { ar: "الفحص البصري", en: "Visual Inspection" },
  HARDNESS: { ar: "فحص الصلادة", en: "Hardness Inspection" },
  FINISH: { ar: "تشطيب السطح", en: "Surface Finish" },
  DIMENSIONAL: { ar: "الفحص الأبعادي", en: "Dimensional Inspection" },
};

export const STATUS_LABELS: Record<Status, { ar: string; en: string }> = {
  PENDING: { ar: "قيد الانتظار", en: "Pending" },
  ACCEPTED: { ar: "مقبول", en: "Accepted" },
  REWORK: { ar: "إعادة تشغيل", en: "Rework" },
  REJECTED: { ar: "مرفوض", en: "Rejected" },
  FURTHER_INVESTIGATION: { ar: "يحتاج فحصًا إضافيًا", en: "Further Investigation" },
  RELEASED: { ar: "مُفرج عنه", en: "Accepted / Released" },
};

/** The part stages, in the order a traveller walks them. */
export const PART_STAGES: readonly Stage[] = STAGE_DEFS.filter(
  (d) => d.subject === "PART"
).map((d) => d.stage);
