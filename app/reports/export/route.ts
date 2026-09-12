import { requireUser } from "@/lib/server/auth";
import { getAllInspectionsForExport } from "@/lib/server/queries";
import { db } from "@/lib/server/firestore";
import { lots, suppliers, type LotDoc, type SupplierDoc } from "@/lib/server/model";
import { measurementResult } from "@/lib/domain/inspection";
import { stageDef } from "@/lib/domain/stages";

export const dynamic = "force-dynamic";

/** Quote a field for CSV and neutralise anything Excel would read as a
 *  formula — inspector names and notes are free text. */
function cell(value: unknown): string {
  if (value == null) return "";
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** One row per checklist answer and per measurement, so the export can be
 *  pivoted in Excel without going back to the app. */
export async function GET() {
  // The whole quality history leaves the building in one file here, so this
  // route carries its own guard as well as the one inside the query.
  await requireUser();

  const inspections = await getAllInspectionsForExport();

  // The subject and part number are already on each inspection; only the
  // supplier still needs looking up, and it is fetched once per distinct lot
  // rather than once per row.
  const lotIds = [...new Set(inspections.map((i) => i.lotId).filter((id): id is string => Boolean(id)))];
  const lotDocs = lotIds.length
    ? await db().getAll(...lotIds.map((id) => lots().doc(id)))
    : [];
  const supplierIdByLot = new Map<string, string>();
  for (const snap of lotDocs) {
    const supplierId = snap.exists ? (snap.data() as LotDoc).supplierId : null;
    if (supplierId) supplierIdByLot.set(snap.id, supplierId);
  }

  const supplierIds = [...new Set(supplierIdByLot.values())];
  const supplierDocs = supplierIds.length
    ? await db().getAll(...supplierIds.map((id) => suppliers().doc(id)))
    : [];
  const supplierNameById = new Map<string, string>();
  for (const snap of supplierDocs)
    if (snap.exists) supplierNameById.set(snap.id, (snap.data() as SupplierDoc).name);

  const supplierNameForLot = (lotId: string | null): string => {
    if (!lotId) return "";
    const supplierId = supplierIdByLot.get(lotId);
    return supplierId ? (supplierNameById.get(supplierId) ?? "") : "";
  };

  const header = [
    "Inspection ID",
    "Date",
    "Stage",
    "Stage (AR)",
    "Subject",
    "Part Number",
    "Supplier",
    "Inspector",
    "Inspection Status",
    "Row Type",
    "Item",
    "Item (AR)",
    "Result",
    "Required",
    "Actual",
    "Unit",
    "Critical",
    "Note",
  ];

  const rows: string[] = [header.map(cell).join(",")];

  for (const insp of inspections) {
    const def = stageDef(insp.stage);
    const base = [
      insp.id,
      insp.inspectedAt.toISOString(),
      def.en,
      def.ar,
      insp.subject,
      insp.partNumber,
      supplierNameForLot(insp.lotId),
      insp.inspector,
      insp.status,
    ];

    for (const item of def.items) {
      const c = insp.checks.find((x) => x.key === item.key);
      rows.push(
        [
          ...base,
          "CHECK",
          item.en,
          item.ar,
          c?.ok === true ? "OK" : c?.ok === false ? "NOT OK" : "UNANSWERED",
          "",
          "",
          "",
          "",
          c?.note ?? "",
        ]
          .map(cell)
          .join(",")
      );
    }

    for (const m of insp.measurements) {
      const required =
        m.kind === "GDT"
          ? `<= ${m.gdtLimit ?? ""}`
          : m.nominal == null
            ? ""
            : `${m.nominal} +${m.tolPlus}/-${m.tolMinus}`;
      rows.push(
        [
          ...base,
          "MEASUREMENT",
          m.name,
          m.name,
          measurementResult(m),
          required,
          m.actual ?? "",
          m.unit,
          m.critical ? "YES" : "NO",
          "",
        ]
          .map(cell)
          .join(",")
      );
    }

    if (insp.hardnessValue != null) {
      rows.push(
        [
          ...base,
          "HARDNESS",
          "Hardness",
          "الصلادة",
          "",
          `${insp.hardnessMin ?? ""} - ${insp.hardnessMax ?? ""}`,
          insp.hardnessValue,
          insp.hardnessUnit ?? "",
          "",
          "",
        ]
          .map(cell)
          .join(",")
      );
    }
  }

  const stamp = new Date().toISOString().slice(0, 10);
  // BOM so Excel opens the Arabic columns in UTF-8 without a manual import.
  return new Response("﻿" + rows.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="quality-inspection-${stamp}.csv"`,
    },
  });
}
