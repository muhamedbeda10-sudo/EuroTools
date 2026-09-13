import { describe, expect, it } from "vitest";

import { column, date, num, parseDefects, parseDimensions, parsePlanning, stage } from "./parse";

const PLANNING_HEADERS = [
  "Project",
  "MPLPR",
  "Item",
  "Name",
  "Qty",
  "Measuring type",
  "Date",
  "Priority",
  "Duration",
  "Description",
  "Complete",
];

const row = (over: Partial<Record<number, unknown>> = {}) => {
  const base: unknown[] = [
    "MM260001",
    "MP",
    "Core",
    "Core insert",
    5,
    "CMM",
    "12/09/2026",
    "A",
    "",
    "first off",
    "",
  ];
  for (const [i, v] of Object.entries(over)) base[Number(i)] = v;
  return base;
};

describe("finding a column however it was typed", () => {
  it("ignores case, spaces and punctuation", () => {
    const headers = ["Project ", "MEASURING-TYPE", "tol_minus", "Tol +"];
    expect(column(headers, "project")).toBe(0);
    expect(column(headers, "measuringtype")).toBe(1);
    expect(column(headers, "tolminus")).toBe(2);
    expect(column(headers, "tol+")).toBe(3);
  });

  it("says nothing rather than guessing at a column that is absent", () => {
    expect(column(["Project"], "qty")).toBeNull();
  });
});

describe("reading a number out of a cell", () => {
  it("takes a real number, a decimal comma, and a unit somebody typed", () => {
    expect(num(50.02)).toBe(50.02);
    expect(num("50,02")).toBe(50.02);
    expect(num("50.02 mm")).toBe(50.02);
    expect(num("-0.015")).toBe(-0.015);
  });

  it("returns nothing for a blank or for words", () => {
    for (const v of [null, undefined, "", "   ", "n/a", "TBC"]) expect(num(v)).toBeNull();
  });
});

describe("reading a date out of a cell", () => {
  it("reads Excel's own serial number", () => {
    // 46277 is 2026-09-12 on Excel's epoch, bug and all.
    expect(date(46277)?.toISOString().slice(0, 10)).toBe("2026-09-12");
  });

  it("reads a slash date as day first, which is how this plant writes one", () => {
    expect(date("12/09/2026")?.toISOString().slice(0, 10)).toBe("2026-09-12");
    expect(date("1/2/26")?.toISOString().slice(0, 10)).toBe("2026-02-01");
  });

  it("returns nothing for a blank or for nonsense", () => {
    expect(date("")).toBeNull();
    expect(date("later")).toBeNull();
  });
});

describe("the stage column", () => {
  it("accepts what people actually type", () => {
    for (const v of ["Roughing", "rough", "ROUGH", "ROUGHING"]) expect(stage(v)).toBe("ROUGHING");
    for (const v of ["Finish", "finishing", "FIN"]) expect(stage(v)).toBe("FINISH");
    expect(stage("grinding")).toBeNull();
  });
});

describe("the planning sheet", () => {
  it("reads a row as planning wrote it", () => {
    const { rows, problems } = parsePlanning([PLANNING_HEADERS, row()]);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project: "MM260001",
      mplpr: "MP",
      itemCode: "Core",
      itemName: "Core insert",
      qty: 5,
      measuringType: "CMM",
      priority: "A",
    });
    expect(rows[0].plannedAt.toISOString().slice(0, 10)).toBe("2026-09-12");
  });

  it("reads past Duration, Description and Complete", () => {
    // All three are answers this application works out and hands back: how
    // long a piece sat with quality, how many times it had to be measured, and
    // whether it is still here. Reading planning's guess at any of them would
    // be circular.
    const { rows } = parsePlanning([
      PLANNING_HEADERS,
      row({ 8: "3 days", 9: "measured 4 times", 10: "Yes" }),
    ]);
    for (const theirs of ["duration", "description", "complete"])
      expect(Object.keys(rows[0])).not.toContain(theirs);
  });

  it("refuses the whole sheet when a column it cannot work without is absent", () => {
    const { rows, problems } = parsePlanning([["Project", "Name"], ["MM260001", "Core"]]);
    expect(rows).toEqual([]);
    expect(problems[0].message).toContain("item");
    expect(problems[0].message).toContain("qty");
  });

  it("refuses a row rather than guessing at its quantity", () => {
    // Guessing here creates the wrong number of pieces, and nobody notices
    // until the count on the bench disagrees with the count on the screen.
    for (const bad of ["", "a few", 0, -2, 2.5]) {
      const { rows, problems } = parsePlanning([PLANNING_HEADERS, row({ 4: bad })]);
      expect(rows).toEqual([]);
      expect(problems[0].message).toContain("whole number");
    }
  });

  it("refuses a row whose measuring type it does not recognise", () => {
    // It decides whether the piece goes to the CMM or to the bench.
    const { rows, problems } = parsePlanning([PLANNING_HEADERS, row({ 5: "somehow" })]);
    expect(rows).toEqual([]);
    expect(problems[0].message).toContain("CMM or Traditional");
  });

  it("accepts the spellings people use for the measuring type", () => {
    for (const [typed, expected] of [
      ["CMM", "CMM"],
      ["cmm", "CMM"],
      ["Traditional", "TRADITIONAL"],
      ["manual", "TRADITIONAL"],
      ["conventional", "TRADITIONAL"],
    ] as const) {
      const { rows } = parsePlanning([PLANNING_HEADERS, row({ 5: typed })]);
      expect(rows[0]?.measuringType).toBe(expected);
    }
  });

  it("keeps going past a bad row and says which one it was", () => {
    const { rows, problems } = parsePlanning([
      PLANNING_HEADERS,
      row(),
      row({ 0: "" }),
      row({ 2: "Cavity" }),
    ]);
    expect(rows.map((r) => r.itemCode)).toEqual(["Core", "Cavity"]);
    expect(problems).toEqual([{ row: 3, message: "No project number." }]);
  });

  it("skips the blank rows every real sheet has at the bottom", () => {
    const { rows, problems } = parsePlanning([PLANNING_HEADERS, row(), [], ["", "", ""]]);
    expect(rows).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  it("falls back to the item code when nobody typed a name", () => {
    const { rows } = parsePlanning([PLANNING_HEADERS, row({ 3: "" })]);
    expect(rows[0].itemName).toBe("Core");
  });
});

describe("the dimensions sheet", () => {
  const headers = ["Item", "Item name", "Stage", "Dimension", "Unit", "Nominal", "Tol -", "Tol +"];

  it("reads a dimension and keeps the tolerances as magnitudes", () => {
    // "-0.02" and "0.02" in the minus column mean the same thing, and neither
    // may widen the band upwards.
    const { rows, problems } = parseDimensions([
      headers,
      ["Core", "Core insert", "Roughing", "Outside diameter", "mm", 50.6, -0.2, 0.2],
    ]);
    expect(problems).toEqual([]);
    expect(rows[0]).toEqual({
      itemCode: "Core",
      itemName: "Core insert",
      stage: "ROUGHING",
      name: "Outside diameter",
      unit: "mm",
      nominal: 50.6,
      tolMinus: 0.2,
      tolPlus: 0.2,
    });
  });

  it("refuses a row whose stage it does not recognise", () => {
    const { rows, problems } = parseDimensions([headers, ["Core", "", "Grinding", "OD", "mm", 50, 0.1, 0.1]]);
    expect(rows).toEqual([]);
    expect(problems[0].message).toContain("Roughing or Finish");
  });

  it("accepts a dimension with no nominal yet, for a sheet still being filled in", () => {
    const { rows, problems } = parseDimensions([headers, ["Core", "", "Finish", "Runout", "mm", "", "", ""]]);
    expect(problems).toEqual([]);
    expect(rows[0]).toMatchObject({ name: "Runout", nominal: null });
  });
});

describe("the defects sheet", () => {
  it("reads a list of defect names", () => {
    const { rows, problems } = parseDefects([["Defect"], ["Scratch"], ["Burn"]]);
    expect(problems).toEqual([]);
    expect(rows).toEqual([{ name: "Scratch" }, { name: "Burn" }]);
  });

  it("ignores columns an older sheet still carries", () => {
    // Item and Department used to be part of this sheet. Somebody will import
    // one of those, and it should bring the defects in rather than refuse.
    const { rows, problems } = parseDefects([
      ["Item", "Defect", "Department"],
      ["Core", "Scratch", "Grinding"],
    ]);
    expect(problems).toEqual([]);
    expect(rows).toEqual([{ name: "Scratch" }]);
  });

  it("says which column it needs when the defect column is missing", () => {
    const { rows, problems } = parseDefects([["Item", "Department"], ["Core", "Grinding"]]);
    expect(rows).toEqual([]);
    expect(problems[0].message).toContain("Defect");
  });

  it("reports the row when a name is blank rather than storing an unnamed defect", () => {
    const { rows, problems } = parseDefects([["Defect"], ["Scratch"], [""], ["  "], ["Burn"]]);
    expect(rows.map((r) => r.name)).toEqual(["Scratch", "Burn"]);
    expect(problems).toEqual([]);
  });
});
