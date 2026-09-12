"use client";

import { getDocs, query, where, documentId } from "firebase/firestore";

import { measurementResult } from "@/lib/domain/inspection";
import { stageDef } from "@/lib/domain/stages";
import { getAllInspectionsForExport } from "@/lib/client/queries";
import { lots, suppliers } from "@/lib/client/db";
import type { LotDoc, SupplierDoc } from "@/lib/model";

/** The whole quality history as one CSV, built in the browser.
 *
 *  This used to be a route handler. A static site has no routes to handle, so
 *  the same rows are assembled here and handed to the browser as a download.
 *  Reading every inspection is the point of the export, which is why the
 *  reports page goes to such lengths to avoid it and this does not.
 */

function cell(value: unknown): string {
  if (value == null) return "";
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}


export async function buildInspectionCsv(): Promise<string> {
  const inspections = await getAllInspectionsForExport();

  // The subject and part number are already on each inspection; only the
  // supplier still needs looking up, and once per distinct lot rather than
  // once per row.
  const lotIds = [
    ...new Set(inspections.map((i) => i.lotId).filter((id): id is string => Boolean(id))),
  ];

  const supplierIdByLot = new Map<string, string>();
  for (let i = 0; i < lotIds.length; i += 30) {
    const snapshot = await getDocs(
      query(lots(), where(documentId(), "in", lotIds.slice(i, i + 30)))
    );
    for (const d of snapshot.docs) {
      const supplierId = (d.data() as LotDoc).supplierId;
      if (supplierId) supplierIdByLot.set(d.id, supplierId);
    }
  }

  const supplierIds = [...new Set(supplierIdByLot.values())];
  const supplierNameById = new Map<string, string>();
  for (let i = 0; i < supplierIds.length; i += 30) {
    const snapshot = await getDocs(
      query(suppliers(), where(documentId(), "in", supplierIds.slice(i, i + 30)))
    );
    for (const d of snapshot.docs)
      supplierNameById.set(d.id, (d.data() as SupplierDoc).name);
  }

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
          "Hardness",
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

  // BOM so Excel opens the Arabic columns in UTF-8 without a manual import.
  return "\ufeff" + rows.join("\r\n");
}

/** Hand the file to the browser. A static site cannot set a download header,
 *  so the anchor does it. */
export async function downloadInspectionCsv(): Promise<void> {
  const csv = await buildInspectionCsv();
  const stamp = new Date().toISOString().slice(0, 10);

  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `quality-inspection-${stamp}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
