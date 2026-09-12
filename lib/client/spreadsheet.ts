"use client";

import { parseCsv } from "@/lib/import/csv";

/** Opening a file somebody dropped on the page.
 *
 *  Everything that can be *wrong* with a sheet is decided in
 *  `lib/import/parse.ts`, where it is tested without a file. This is only the
 *  part that turns bytes into a grid, and it is kept separate for that reason:
 *  the xlsx reader is loaded on demand, so the hundred kilobytes it costs are
 *  paid by the two screens that import and by nobody else.
 */
export async function readGrid(file: File): Promise<unknown[][]> {
  const name = file.name.toLowerCase();

  if (name.endsWith(".csv") || name.endsWith(".txt") || file.type === "text/csv")
    return parseCsv(await file.text());

  if (!/\.(xlsx|xlsm)$/.test(name))
    throw new Error("That file is not a spreadsheet. Use .xlsx or .csv.");

  // The browser build by name: the package's default entry is not resolvable
  // outside a bundler, and naming the subpath keeps the test runner able to
  // load this module at all.
  const { default: readXlsxFile } = await import("read-excel-file/browser");
  // Every cell as it was typed: the parser decides what a value means, and a
  // reader that had already coerced "50,02" would have decided first.
  return (await readXlsxFile(file)) as unknown as unknown[][];
}
