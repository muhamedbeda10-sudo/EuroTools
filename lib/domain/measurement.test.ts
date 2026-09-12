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
    const s = suggest([dim()], [{ key: "scratch", name: "Scratch", department: "Grinding" }]);
    expect(s.verdict).toBe("HOLD");
    expect(s.reasons.join(" ")).toContain("Scratch");
  });

  it("suggests the department when every defect points at the same one", () => {
    const s = suggest(
      [dim()],
      [
        { key: "scratch", name: "Scratch", department: "Grinding" },
        { key: "burn", name: "Burn", department: "Grinding" },
      ]
    );
    expect(s.department).toBe("Grinding");
  });

  it("suggests nobody when the defects disagree", () => {
    // Two departments and one hold: the inspector decides, not a coin toss.
    const s = suggest(
      [dim()],
      [
        { key: "scratch", name: "Scratch", department: "Grinding" },
        { key: "dent", name: "Dent", department: "Handling" },
      ]
    );
    expect(s.department).toBeNull();
  });

  it("never suggests a bypass", () => {
    // A concession is a decision a person takes and answers for. Nothing here
    // may arrive at one on its own.
    const s = suggest([dim({ actual: 60 })], []);
    expect(s.verdict).toBe("HOLD");
  });
});
