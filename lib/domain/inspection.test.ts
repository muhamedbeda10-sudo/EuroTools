import { describe, expect, it } from "vitest";
import {
  analysisResultPass,
  analysisStatus,
  canInspect,
  canRaiseParts,
  deviation,
  hardnessVerdict,
  measurementResult,
  missingCertificates,
  nextPartState,
  rollup,
  surfaceFinishOk,
  toleranceBand,
  travellerProgress,
} from "./inspection";
import { PART_STAGES, STAGE_DEFS, stageDef } from "./stages";

// ───────────────────────── measurements ─────────────────────────

describe("toleranceBand", () => {
  it("treats both tolerances as magnitudes", () => {
    expect(toleranceBand({ nominal: 50, tolMinus: 0.05, tolPlus: 0.05 })).toEqual({
      min: 49.95,
      max: 50.05,
    });
  });

  it("accepts a negative tolMinus written by habit", () => {
    expect(toleranceBand({ nominal: 50, tolMinus: -0.05, tolPlus: 0.05 })).toEqual({
      min: 49.95,
      max: 50.05,
    });
  });

  it("supports an asymmetric band", () => {
    expect(toleranceBand({ nominal: 20, tolMinus: 0, tolPlus: 0.1 })).toEqual({
      min: 20,
      max: 20.1,
    });
  });

  it("has no band without a nominal", () => {
    expect(toleranceBand({ nominal: null, tolMinus: 1, tolPlus: 1 })).toBeNull();
  });
});

describe("measurementResult", () => {
  const dim = { nominal: 50, tolMinus: 0.05, tolPlus: 0.05 };

  it("passes inside the band", () => {
    expect(measurementResult({ ...dim, actual: 50 })).toBe("PASS");
    expect(measurementResult({ ...dim, actual: 49.97 })).toBe("PASS");
  });

  it("passes exactly on both limits", () => {
    expect(measurementResult({ ...dim, actual: 49.95 })).toBe("PASS");
    expect(measurementResult({ ...dim, actual: 50.05 })).toBe("PASS");
  });

  it("fails outside the band on either side", () => {
    expect(measurementResult({ ...dim, actual: 49.9 })).toBe("FAIL");
    expect(measurementResult({ ...dim, actual: 50.06 })).toBe("FAIL");
  });

  it("is pending with no reading", () => {
    expect(measurementResult({ ...dim, actual: null })).toBe("PENDING");
    expect(measurementResult({ ...dim, actual: NaN })).toBe("PENDING");
  });

  it("reads a GD&T callout as 0…limit", () => {
    const gdt = { kind: "GDT" as const, gdtLimit: 0.02 };
    expect(measurementResult({ ...gdt, actual: 0 })).toBe("PASS");
    expect(measurementResult({ ...gdt, actual: 0.02 })).toBe("PASS");
    expect(measurementResult({ ...gdt, actual: 0.021 })).toBe("FAIL");
    expect(measurementResult({ ...gdt, actual: -0.01 })).toBe("FAIL");
  });

  it("ignores the tolerance band for a GD&T callout", () => {
    // A runout of 0.5 is a fail even though a ±1 band would have swallowed it.
    expect(
      measurementResult({
        kind: "GDT",
        gdtLimit: 0.02,
        nominal: 0,
        tolMinus: 1,
        tolPlus: 1,
        actual: 0.5,
      })
    ).toBe("FAIL");
  });
});

describe("deviation", () => {
  const dim = { nominal: 50, tolMinus: 0.05, tolPlus: 0.05 };

  it("is zero in tolerance", () => {
    expect(deviation({ ...dim, actual: 50 })).toBe(0);
  });

  it("measures how far past the near limit a reading sits", () => {
    expect(deviation({ ...dim, actual: 50.15 })).toBeCloseTo(0.1, 10);
    expect(deviation({ ...dim, actual: 49.85 })).toBeCloseTo(0.1, 10);
  });

  it("measures overshoot past a GD&T limit", () => {
    expect(deviation({ kind: "GDT", gdtLimit: 0.02, actual: 0.05 })).toBeCloseTo(0.03, 10);
  });
});

// ───────────────────────── hardness ─────────────────────────

describe("hardnessVerdict", () => {
  it("reads a two-sided window", () => {
    expect(hardnessVerdict(60, 58, 62)).toBe("IN_RANGE");
    expect(hardnessVerdict(58, 58, 62)).toBe("IN_RANGE");
    expect(hardnessVerdict(62, 58, 62)).toBe("IN_RANGE");
    expect(hardnessVerdict(57.9, 58, 62)).toBe("BELOW");
    expect(hardnessVerdict(62.1, 58, 62)).toBe("ABOVE");
  });

  it("honours a one-sided window", () => {
    expect(hardnessVerdict(70, 58, null)).toBe("IN_RANGE");
    expect(hardnessVerdict(50, 58, null)).toBe("BELOW");
    expect(hardnessVerdict(30, null, 40)).toBe("IN_RANGE");
    expect(hardnessVerdict(45, null, 40)).toBe("ABOVE");
  });

  it("is unknown with no reading or no spec", () => {
    expect(hardnessVerdict(null, 58, 62)).toBe("UNKNOWN");
    expect(hardnessVerdict(60, null, null)).toBe("UNKNOWN");
  });
});

describe("surfaceFinishOk", () => {
  it("accepts a smoother-than-required finish", () => {
    expect(surfaceFinishOk(0.2, 0.4)).toBe(true);
    expect(surfaceFinishOk(0.4, 0.4)).toBe(true);
    expect(surfaceFinishOk(0.5, 0.4)).toBe(false);
  });

  it("is unknown when either side is missing", () => {
    expect(surfaceFinishOk(null, 0.4)).toBeNull();
    expect(surfaceFinishOk(0.4, null)).toBeNull();
  });
});

// ───────────────────────── rollup ─────────────────────────

/** Every checklist line for a stage answered with the same value. */
function answerAll(stage: Parameters<typeof stageDef>[0], ok: boolean | null) {
  const checks: Record<string, boolean | null> = {};
  for (const item of stageDef(stage).items) checks[item.key] = ok;
  return checks;
}

describe("rollup", () => {
  it("accepts a clean post-roughing sheet", () => {
    const r = rollup({ stage: "POST_ROUGHING", checks: answerAll("POST_ROUGHING", true) });
    expect(r.suggested).toBe("ACCEPTED");
    expect(r.reasons).toEqual(["all-clear"]);
  });

  it("releases — not merely accepts — a clean final sheet", () => {
    const r = rollup({ stage: "FINAL", checks: answerAll("FINAL", true) });
    expect(r.suggested).toBe("RELEASED");
  });

  it("stays pending while a line is unanswered", () => {
    const checks = answerAll("POST_ROUGHING", true);
    checks.allowance_ok = null;
    const r = rollup({ stage: "POST_ROUGHING", checks });
    expect(r.suggested).toBe("PENDING");
    expect(r.unanswered).toEqual(["allowance_ok"]);
    expect(r.reasons).toContain("checklist-incomplete");
  });

  it("sends a failed check to rework where the stage allows it", () => {
    const checks = answerAll("POST_GRINDING", true);
    checks.no_grinding_burn = false;
    const r = rollup({ stage: "POST_GRINDING", checks });
    expect(r.suggested).toBe("REWORK");
    expect(r.failedChecks).toEqual(["no_grinding_burn"]);
  });

  it("does not wait for a complete sheet to report a failure", () => {
    const checks = answerAll("POST_GRINDING", null);
    checks.no_grinding_burn = false;
    const r = rollup({ stage: "POST_GRINDING", checks });
    expect(r.suggested).toBe("REWORK");
    expect(r.reasons).not.toContain("checklist-incomplete");
  });

  it("rejects outright when a critical dimension is out", () => {
    const r = rollup({
      stage: "FINAL",
      checks: answerAll("FINAL", true),
      measurements: [
        { nominal: 50, tolMinus: 0.01, tolPlus: 0.01, actual: 50.5, critical: true },
      ],
    });
    expect(r.suggested).toBe("REJECTED");
    expect(r.criticalFailure).toBe(true);
    expect(r.failedMeasurements).toEqual([0]);
  });

  it("sends a non-critical dimension miss to rework", () => {
    const r = rollup({
      stage: "FINAL",
      checks: answerAll("FINAL", true),
      measurements: [
        { nominal: 50, tolMinus: 0.01, tolPlus: 0.01, actual: 50.5, critical: false },
      ],
    });
    expect(r.suggested).toBe("REWORK");
    expect(r.criticalFailure).toBe(false);
  });

  it("rejects soft parts after heat treatment", () => {
    const r = rollup({
      stage: "HEAT_TREATMENT",
      checks: answerAll("HEAT_TREATMENT", true),
      hardness: { value: 55, min: 58, max: 62 },
    });
    expect(r.suggested).toBe("REJECTED");
    expect(r.hardness).toBe("BELOW");
  });

  it("sends over-hard parts to further investigation, not the scrap bin", () => {
    const r = rollup({
      stage: "HEAT_TREATMENT",
      checks: answerAll("HEAT_TREATMENT", true),
      hardness: { value: 65, min: 58, max: 62 },
    });
    expect(r.suggested).toBe("FURTHER_INVESTIGATION");
    expect(r.hardness).toBe("ABOVE");
  });

  it("accepts heat treatment inside the window", () => {
    const r = rollup({
      stage: "HEAT_TREATMENT",
      checks: answerAll("HEAT_TREATMENT", true),
      hardness: { value: 60, min: 58, max: 62 },
    });
    expect(r.suggested).toBe("ACCEPTED");
  });

  it("routes a failed heat-treatment check to further investigation (no rework outcome)", () => {
    const checks = answerAll("HEAT_TREATMENT", true);
    checks.no_cracks = false;
    const r = rollup({
      stage: "HEAT_TREATMENT",
      checks,
      hardness: { value: 60, min: 58, max: 62 },
    });
    expect(r.suggested).toBe("FURTHER_INVESTIGATION");
  });

  it("lets a critical failure outrank an out-of-range hardness", () => {
    const r = rollup({
      stage: "HEAT_TREATMENT",
      checks: answerAll("HEAT_TREATMENT", true),
      hardness: { value: 65, min: 58, max: 62 },
      measurements: [{ nominal: 10, tolMinus: 0.01, tolPlus: 0.01, actual: 12, critical: true }],
    });
    expect(r.suggested).toBe("REJECTED");
  });

  it("only ever suggests an outcome the stage actually offers", () => {
    for (const def of STAGE_DEFS) {
      const clean = rollup({ stage: def.stage, checks: answerAll(def.stage, true) });
      expect(def.outcomes).toContain(clean.suggested);

      const failed = rollup({
        stage: def.stage,
        checks: { ...answerAll(def.stage, true), [def.items[0].key]: false },
      });
      expect([...def.outcomes, "PENDING"]).toContain(failed.suggested);
    }
  });
});

// ───────────────────────── traveller flow ─────────────────────────

describe("nextPartState", () => {
  it("walks the whole route on acceptance", () => {
    expect(nextPartState("POST_ROUGHING", "ACCEPTED")).toEqual({
      stage: "HEAT_TREATMENT",
      status: "IN_PROCESS",
    });
    expect(nextPartState("HEAT_TREATMENT", "ACCEPTED")).toEqual({
      stage: "POST_GRINDING",
      status: "IN_PROCESS",
    });
    expect(nextPartState("POST_GRINDING", "ACCEPTED")).toEqual({
      stage: "FINAL",
      status: "IN_PROCESS",
    });
    expect(nextPartState("FINAL", "RELEASED")).toEqual({ stage: "DONE", status: "RELEASED" });
  });

  it("holds a part in place for rework", () => {
    expect(nextPartState("POST_GRINDING", "REWORK")).toEqual({
      stage: "POST_GRINDING",
      status: "REWORK",
    });
  });

  it("puts a further-investigation part on hold at its stage", () => {
    expect(nextPartState("HEAT_TREATMENT", "FURTHER_INVESTIGATION")).toEqual({
      stage: "HEAT_TREATMENT",
      status: "HOLD",
    });
  });

  it("ends the traveller on rejection", () => {
    expect(nextPartState("POST_ROUGHING", "REJECTED")).toEqual({
      stage: "POST_ROUGHING",
      status: "REJECTED",
    });
  });

  it("refuses a verdict the stage does not offer", () => {
    expect(() => nextPartState("HEAT_TREATMENT", "REWORK")).toThrow();
    expect(() => nextPartState("POST_ROUGHING", "RELEASED")).toThrow();
  });

  it("refuses a raw-material stage", () => {
    expect(() => nextPartState("RAW_RECEIVING", "ACCEPTED")).toThrow();
  });
});

describe("canInspect", () => {
  it("allows the stage the part is standing in", () => {
    expect(canInspect({ currentStage: "FINAL", status: "IN_PROCESS" }, "FINAL").ok).toBe(true);
  });

  it("allows re-inspection of a reworked part at the same stage", () => {
    expect(canInspect({ currentStage: "POST_GRINDING", status: "REWORK" }, "POST_GRINDING").ok).toBe(
      true
    );
  });

  it("blocks skipping ahead", () => {
    const r = canInspect({ currentStage: "POST_ROUGHING", status: "IN_PROCESS" }, "FINAL");
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("blocks a rejected or released part", () => {
    expect(canInspect({ currentStage: "FINAL", status: "REJECTED" }, "FINAL").ok).toBe(false);
    expect(canInspect({ currentStage: "DONE", status: "RELEASED" }, "FINAL").ok).toBe(false);
  });
});

describe("canRaiseParts", () => {
  it("needs an accepted lot", () => {
    expect(canRaiseParts({ status: "PENDING" }).ok).toBe(false);
    expect(canRaiseParts({ status: "REJECTED" }).ok).toBe(false);
  });

  it("allows an accepted lot with no analysis on file", () => {
    expect(canRaiseParts({ status: "ACCEPTED", analyses: [] }).ok).toBe(true);
  });

  it("blocks when any analysis was rejected", () => {
    expect(
      canRaiseParts({ status: "ACCEPTED", analyses: [{ status: "ACCEPTED" }, { status: "REJECTED" }] })
        .ok
    ).toBe(false);
  });

  it("blocks while every analysis is still pending", () => {
    expect(canRaiseParts({ status: "ACCEPTED", analyses: [{ status: "PENDING" }] }).ok).toBe(false);
  });

  it("allows once at least one analysis came back accepted", () => {
    expect(
      canRaiseParts({ status: "ACCEPTED", analyses: [{ status: "ACCEPTED" }, { status: "PENDING" }] })
        .ok
    ).toBe(true);
  });
});

describe("travellerProgress", () => {
  it("advances a quarter per part stage", () => {
    expect(travellerProgress({ currentStage: "POST_ROUGHING", status: "IN_PROCESS" })).toBe(0);
    expect(travellerProgress({ currentStage: "HEAT_TREATMENT", status: "IN_PROCESS" })).toBe(0.25);
    expect(travellerProgress({ currentStage: "FINAL", status: "IN_PROCESS" })).toBe(0.75);
    expect(travellerProgress({ currentStage: "DONE", status: "RELEASED" })).toBe(1);
  });

  it("covers exactly the four part stages", () => {
    expect(PART_STAGES).toEqual([
      "POST_ROUGHING",
      "HEAT_TREATMENT",
      "POST_GRINDING",
      "FINAL",
    ]);
  });
});

// ───────────────────────── raw material ─────────────────────────

describe("missingCertificates", () => {
  it("lists what has not arrived", () => {
    expect(
      missingCertificates("Mill Test Certificate, RoHS", [
        { type: "Mill Test Certificate", received: true },
      ])
    ).toEqual(["RoHS"]);
  });

  it("ignores case and padding", () => {
    expect(
      missingCertificates(" mill test certificate ", [
        { type: "Mill Test Certificate", received: true },
      ])
    ).toEqual([]);
  });

  it("does not count a certificate that was logged but never received", () => {
    expect(
      missingCertificates("RoHS", [{ type: "RoHS", received: false }])
    ).toEqual(["RoHS"]);
  });

  it("requires nothing when the material requires nothing", () => {
    expect(missingCertificates(null, [])).toEqual([]);
    expect(missingCertificates("", [])).toEqual([]);
  });
});

describe("analysisResultPass", () => {
  it("compares a numeric reading against its window", () => {
    expect(analysisResultPass({ requiredMin: 1.4, requiredMax: 1.6, actual: 1.5 })).toBe(true);
    expect(analysisResultPass({ requiredMin: 1.4, requiredMax: 1.6, actual: 1.7 })).toBe(false);
    expect(analysisResultPass({ requiredMin: 1.4, requiredMax: 1.6, actual: 1.3 })).toBe(false);
  });

  it("honours a one-sided window", () => {
    expect(analysisResultPass({ requiredMax: 0.03, actual: 0.02 })).toBe(true);
    expect(analysisResultPass({ requiredMax: 0.03, actual: 0.04 })).toBe(false);
  });

  it("compares a textual requirement literally", () => {
    expect(analysisResultPass({ requiredText: "Pass", actualText: "pass" })).toBe(true);
    expect(analysisResultPass({ requiredText: "Pass", actualText: "Fail" })).toBe(false);
    expect(analysisResultPass({ requiredText: "Pass", actualText: null })).toBeNull();
  });

  it("is unknown without a reading or without a requirement", () => {
    expect(analysisResultPass({ requiredMin: 1, requiredMax: 2, actual: null })).toBeNull();
    expect(analysisResultPass({ actual: 1.5 })).toBeNull();
  });
});

describe("analysisStatus", () => {
  it("rejects the sample when any property is out", () => {
    expect(
      analysisStatus([
        { requiredMin: 1.4, requiredMax: 1.6, actual: 1.5 },
        { requiredMin: 11, requiredMax: 13, actual: 9 },
      ])
    ).toBe("REJECTED");
  });

  it("stays pending while a property is unread", () => {
    expect(
      analysisStatus([
        { requiredMin: 1.4, requiredMax: 1.6, actual: 1.5 },
        { requiredMin: 11, requiredMax: 13, actual: null },
      ])
    ).toBe("PENDING");
  });

  it("lets a failure outrank an unread property", () => {
    expect(
      analysisStatus([
        { requiredMin: 11, requiredMax: 13, actual: 9 },
        { requiredMin: 1.4, requiredMax: 1.6, actual: null },
      ])
    ).toBe("REJECTED");
  });

  it("accepts once every property is read and in range", () => {
    expect(
      analysisStatus([
        { requiredMin: 1.4, requiredMax: 1.6, actual: 1.5 },
        { requiredMax: 0.03, actual: 0.01 },
      ])
    ).toBe("ACCEPTED");
  });

  it("is pending with nothing measured at all", () => {
    expect(analysisStatus([])).toBe("PENDING");
  });
});
