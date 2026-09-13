import { describe, expect, it } from "vitest";

import { deviation, result, suggest, toleranceBand, type Reading } from "./measurement";

const dim = (over: Partial<Reading> = {}): Reading => ({
  key: "od",
  name: "Outside diameter",
  nominal: 50,
  tolMinus: 0.02,
  tolPlus: 0.02,
  actual: 50,
  ...over,
});

describe("a reading against its drawing", () => {
  it("passes inside the band and fails outside it", () => {
    expect(result(dim({ actual: 50 }))).toBe("PASS");
    expect(result(dim({ actual: 50.015 }))).toBe("PASS");
    expect(result(dim({ actual: 50.03 }))).toBe("FAIL");
    expect(result(dim({ actual: 49.97 }))).toBe("FAIL");
  });

  it("passes a reading sitting exactly on a limit", () => {
    // The shop-floor convention, pinned so nobody tidies the comparison the
    // other way round: a part on its limit is a part in tolerance.
    expect(result(dim({ actual: 50.02 }))).toBe("PASS");
    expect(result(dim({ actual: 49.98 }))).toBe("PASS");
  });

  it("handles an asymmetric band, which is most of them", () => {
    const h7 = dim({ nominal: 50, tolMinus: 0, tolPlus: 0.025 });
    expect(toleranceBand(h7)).toEqual({ min: 50, max: 50.025 });
    expect(result({ ...h7, actual: 49.999 })).toBe("FAIL");
    expect(result({ ...h7, actual: 50.02 })).toBe("PASS");
  });

  it("reads a tolerance written with a sign as a magnitude", () => {
    // "−0.02" and "0.02" mean the same thing in the minus column, and both get
    // typed. Neither may widen the band upwards.
    expect(toleranceBand(dim({ tolMinus: -0.02 }))).toEqual({ min: 49.98, max: 50.02 });
  });

  it("says nothing rather than passing when there is no reading or no drawing", () => {
    expect(result(dim({ actual: null }))).toBe("NOT_MEASURED");
    expect(result(dim({ actual: Number.NaN }))).toBe("NOT_MEASURED");
    expect(result(dim({ nominal: null }))).toBe("NOT_MEASURED");
  });
});

describe("how far out a reading is", () => {
  it("is signed, so it says which way to correct", () => {
    expect(deviation(dim({ actual: 50.05 }))).toBeCloseTo(0.03, 10);
    expect(deviation(dim({ actual: 49.95 }))).toBeCloseTo(-0.03, 10);
  });

  it("is zero anywhere inside the band", () => {
    expect(deviation(dim({ actual: 50.01 }))).toBe(0);
    expect(deviation(dim({ actual: 50.02 }))).toBe(0);
  });
});

describe("a limit is a limit, whatever binary floating point does to it", () => {
  // `100.7 - 0.1` is `100.60000000000001` as a double, so a part measured at
  // exactly its lower limit used to be rejected. These are the cases that
  // caught it and a sweep wide enough that the next arithmetic change cannot
  // put it back quietly.

  const round = (x: number, places: number) => Number(x.toFixed(places));

  it("passes the reading that used to be rejected", () => {
    expect(result({ nominal: 100.7, tolMinus: 0.1, tolPlus: 0.1, actual: 100.6 })).toBe("PASS");
  });

  it("states the band as the decimal it is, not as the double it computes to", () => {
    // This is what the screen was showing beside the reading.
    expect(toleranceBand({ nominal: 50.6, tolMinus: 0.2, tolPlus: 0.2 })).toEqual({
      min: 50.4,
      max: 50.8,
    });
    expect(toleranceBand({ nominal: 0.3, tolMinus: 0.1, tolPlus: 0.1 })).toEqual({
      min: 0.2,
      max: 0.4,
    });
  });

  it("passes every reading on a limit, across the values a drawing actually uses", () => {
    const rejected: string[] = [];
    for (let tenths = 1; tenths <= 20000; tenths += 1) {
      const nominal = round(tenths / 10, 1);
      for (const tol of [0.05, 0.1, 0.2, 0.25, 0.3, 0.5]) {
        const lo = round(nominal - tol, 3);
        const hi = round(nominal + tol, 3);
        for (const actual of [lo, hi, nominal]) {
          if (result({ nominal, tolMinus: tol, tolPlus: tol, actual }) !== "PASS")
            rejected.push(`${nominal} ±${tol} @ ${actual}`);
        }
      }
    }
    expect(rejected.slice(0, 5)).toEqual([]);
    expect(rejected).toHaveLength(0);
  });

  it("still fails a reading one step outside, so nothing is loosened to fix it", () => {
    // The fix must not become a tolerance of its own: a thousandth over is
    // still over.
    const accepted: string[] = [];
    for (let tenths = 1; tenths <= 20000; tenths += 1) {
      const nominal = round(tenths / 10, 1);
      for (const tol of [0.05, 0.1, 0.2, 0.25, 0.3, 0.5]) {
        for (const actual of [round(nominal - tol - 0.001, 3), round(nominal + tol + 0.001, 3)]) {
          if (result({ nominal, tolMinus: tol, tolPlus: tol, actual }) !== "FAIL")
            accepted.push(`${nominal} ±${tol} @ ${actual}`);
        }
      }
    }
    expect(accepted.slice(0, 5)).toEqual([]);
    expect(accepted).toHaveLength(0);
  });

  it("reports how far out a reading is without the same error", () => {
    expect(deviation({ nominal: 100.7, tolMinus: 0.1, tolPlus: 0.1, actual: 100.5 })).toBe(-0.1);
    expect(deviation({ nominal: 0.3, tolMinus: 0.1, tolPlus: 0.1, actual: 0.5 })).toBe(0.1);
    expect(deviation({ nominal: 100.7, tolMinus: 0.1, tolPlus: 0.1, actual: 100.6 })).toBe(0);
  });

  it("handles a tolerance fine enough to print in exponent form", () => {
    expect(result({ nominal: 1, tolMinus: 1e-7, tolPlus: 1e-7, actual: 0.9999999 })).toBe("PASS");
    expect(result({ nominal: 1, tolMinus: 1e-7, tolPlus: 1e-7, actual: 0.9999998 })).toBe("FAIL");
  });

  it("treats a reading that is not a number as not measured", () => {
    for (const actual of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
      expect(result({ nominal: 10, tolMinus: 1, tolPlus: 1, actual })).toBe("NOT_MEASURED");
  });
});

describe("the verdict the evidence requires", () => {
  it("accepts when every dimension is in tolerance and nothing was seen", () => {
    const s = suggest([dim(), dim({ key: "len", name: "Length", nominal: 120, actual: 120 })], []);
    expect(s.verdict).toBe("ACCEPTED");
    expect(s.failed).toHaveLength(0);
  });

  it("holds on a dimension outside tolerance, and names it", () => {
    const s = suggest([dim(), dim({ key: "len", name: "Length", nominal: 120, actual: 121 })], []);
    expect(s.verdict).toBe("HOLD");
    expect(s.failed.map((f) => f.key)).toEqual(["len"]);
    expect(s.reasons.join(" ")).toContain("Length is outside tolerance");
  });

  it("holds on an unmeasured dimension rather than accepting a half-done sheet", () => {
    // A blank is not a pass. Accepting one would mean a signature covering a
    // dimension nobody looked at.
    const s = suggest([dim({ actual: null })], []);
    expect(s.verdict).toBe("HOLD");
    expect(s.unmeasured).toHaveLength(1);
  });

  it("holds on a visual defect even when every dimension is good", () => {
    const s = suggest([dim()], [{ key: "scratch", name: "Scratch" }]);
    expect(s.verdict).toBe("HOLD");
    expect(s.reasons.join(" ")).toContain("Scratch");
  });

  it("names every defect in its reasons, so the hold says what it is for", () => {
    const s = suggest(
      [dim()],
      [
        { key: "scratch", name: "Scratch" },
        { key: "dent", name: "Dent" },
      ]
    );
    const reasons = s.reasons.join(" ");
    expect(reasons).toContain("Scratch");
    expect(reasons).toContain("Dent");
  });

  it("holds on a defect whatever the readings say, and does not pick a department", () => {
    // Who reworks it is the inspector's call on the hold, not something
    // derived from which defects were ticked. The evidence decides the
    // verdict; a person decides who answers for it.
    const s = suggest([dim({ actual: 50 })], [{ key: "scratch", name: "Scratch" }]);
    expect(s.verdict).toBe("HOLD");
    expect(s).not.toHaveProperty("department");
  });

  it("never suggests a bypass", () => {
    // A concession is a decision a person takes and answers for. Nothing here
    // may arrive at one on its own.
    const s = suggest([dim({ actual: 60 })], []);
    expect(s.verdict).toBe("HOLD");
  });
});
