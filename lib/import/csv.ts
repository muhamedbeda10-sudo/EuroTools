/** Enough CSV for a sheet exported from Excel.
 *
 *  Pure, and beside the other parsing rather than with the file reader, so a
 *  test can reach it without pulling in the xlsx library.
 */
/** Quoted fields, doubled quotes inside them, commas and newlines within
 *  quotes, and the byte-order mark Excel puts at the front. */
export function parseCsv(text: string): unknown[][] {
  const input = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];

    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += c;
      continue;
    }

    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && input[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
