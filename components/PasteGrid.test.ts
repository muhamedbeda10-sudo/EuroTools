import { describe, expect, it } from "vitest";

import { applyPaste, emptyRow, splitClipboard, type GridColumn } from "./PasteGrid";

const COLUMNS: GridColumn[] = [
  { key: "project", label: "Project" },
  { key: "item", label: "Item" },
  { key: "qty", label: "Qty" },
];

const blank = (n: number) => Array.from({ length: n }, () => emptyRow(COLUMNS));

describe("what came off the clipboard", () => {
  it("reads the tab-separated block every spreadsheet copies", () => {
    expect(splitClipboard("a\tb\tc\n1\t2\t3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("survives Windows line endings and a trailing newline", () => {
    expect(splitClipboard("a\tb\r\n1\t2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("leaves a single value alone, so ordinary pasting still works", () => {
    // Somebody copying one part number into one cell must not have it
    // interpreted as a block.
    expect(splitClipboard("MM260001")).toBeNull();
  });
});

describe("where a pasted block lands", () => {
  it("fills from the cell that was focused", () => {
    const rows = applyPaste(blank(2), COLUMNS, [["Core", "5"]], 0, 1);
    expect(rows[0]).toEqual({ project: "", item: "Core", qty: "5" });
  });

  it("grows the grid to hold what was pasted", () => {
    // Pasting forty rows into a grid of one is the normal case, not an edge.
    const rows = applyPaste(blank(1), COLUMNS, [["a"], ["b"], ["c"]], 0, 0);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.project)).toEqual(["a", "b", "c"]);
  });

  it("drops what falls off the right rather than refusing the paste", () => {
    // Excel selections pick up trailing columns all the time, and refusing the
    // whole paste over one would send somebody back to retype it.
    const rows = applyPaste(blank(1), COLUMNS, [["a", "b", "c", "d", "e"]], 0, 0);
    expect(rows[0]).toEqual({ project: "a", item: "b", qty: "c" });
  });

  it("leaves the rows above and to the left untouched", () => {
    const start = [
      { project: "keep", item: "keep", qty: "keep" },
      emptyRow(COLUMNS),
    ];
    const rows = applyPaste(start, COLUMNS, [["x"]], 1, 1);
    expect(rows[0]).toEqual({ project: "keep", item: "keep", qty: "keep" });
    expect(rows[1]).toEqual({ project: "", item: "x", qty: "" });
  });

  it("trims what Excel pads cells with", () => {
    const rows = applyPaste(blank(1), COLUMNS, [["  Core  "]], 0, 0);
    expect(rows[0].project).toBe("Core");
  });
});
