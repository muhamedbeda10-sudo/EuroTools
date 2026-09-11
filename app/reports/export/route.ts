import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/server/auth";
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
  // This route reads straight from Prisma rather than through `queries.ts`, so
  // it carries its own guard. The whole quality history leaves the building in
  // one file here.
  await requireUser();

  const inspections = await prisma.inspection.findMany({
    orderBy: { inspectedAt: "desc" },
    include: {
      checks: true,
      measurements: { orderBy: { sortOrder: "asc" } },
      part: { include: { material: true, lot: { include: { supplier: true } } } },
      lot: { include: { material: true, supplier: true } },
    },
  });

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
    const material = insp.part?.material ?? insp.lot?.material;
    const base = [
      insp.id,
      insp.inspectedAt.toISOString(),
      def.en,
      def.ar,
      insp.part?.serialNumber ?? insp.lot?.lotNumber ?? "",
      material?.partNumber ?? "",
      insp.part?.lot?.supplier?.name ?? insp.lot?.supplier?.name ?? "",
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
