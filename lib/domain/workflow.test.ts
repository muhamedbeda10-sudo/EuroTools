import { describe, expect, it } from "vitest";

import {
  applyReworkDone,
  applyVerdict,
  initialPosition,
  isComplete,
  isWithQc,
  nextStage,
  qcMillis,
  type PiecePosition,
} from "./workflow";

const at = (stage: "ROUGHING" | "FINISH", state: PiecePosition["state"], dept: string | null = null): PiecePosition => ({
  stage,
  state,
  holdDepartment: dept,
});

/** A piece as the transaction reads it: a position plus the round it is on. */
const piece = (
  stage: "ROUGHING" | "FINISH",
  state: PiecePosition["state"],
  dept: string | null = null,
  round = 0
) => ({ ...at(stage, state, dept), round });

/** The sheet an inspector has open, matching the piece unless a test is about
 *  what happens when it does not. */
const sheet = (stage: "ROUGHING" | "FINISH", round = 0) => ({ stage, round });

describe("where a piece starts", () => {
  it("arrives at roughing, on QC's desk", () => {
    expect(initialPosition()).toEqual({
      stage: "ROUGHING",
      state: "WAITING_QC",
      holdDepartment: null,
    });
  });
});

describe("accepting a piece", () => {
  it("moves it from roughing to finish, still waiting on QC", () => {
    // The planning sheet's own words: it disappears from roughing and shows in
    // finish as waiting, until the finishing operation is done and it is
    // measured again.
    const r = applyVerdict(piece("ROUGHING", "WAITING_QC"), "ACCEPTED", null, sheet("ROUGHING"));
    expect(r).toEqual({ ok: true, next: at("FINISH", "WAITING_QC") });
  });

  it("closes it at finish, because there is nowhere after that", () => {
    const r = applyVerdict(piece("FINISH", "WAITING_QC"), "ACCEPTED", null, sheet("FINISH"));
    expect(r).toEqual({ ok: true, next: at("FINISH", "CLOSED") });
  });

  it("treats a bypass as an acceptance for where the piece goes", () => {
    // A concession changes who may sign it and what the audit sees. It does
    // not change the route: the piece is being let through either way.
    for (const stage of ["ROUGHING", "FINISH"] as const) {
      const accepted = applyVerdict(piece(stage, "WAITING_QC"), "ACCEPTED", null, sheet(stage));
      const bypassed = applyVerdict(piece(stage, "WAITING_QC"), "ACCEPTED_BYPASS", null, sheet(stage));
      expect(bypassed).toEqual(accepted);
    }
  });

  it("refuses a department on an acceptance", () => {
    // Otherwise a department appears in the rework figures having done none.
    expect(applyVerdict(piece("ROUGHING", "WAITING_QC"), "ACCEPTED", "Machining", sheet("ROUGHING"))).toEqual({
      ok: false,
      reason: "department-on-acceptance",
    });
  });
});

describe("holding a piece", () => {
  it("keeps it at the same stage and names who must fix it", () => {
    expect(applyVerdict(piece("ROUGHING", "WAITING_QC"), "HOLD", "Machining", sheet("ROUGHING"))).toEqual({
      ok: true,
      next: at("ROUGHING", "WAITING_REWORK", "Machining"),
    });
    expect(applyVerdict(piece("FINISH", "WAITING_QC"), "HOLD", "Grinding", sheet("FINISH"))).toEqual({
      ok: true,
      next: at("FINISH", "WAITING_REWORK", "Grinding"),
    });
  });

  it("refuses a hold with nobody attached", () => {
    // A hold nobody owns is a piece that stops and is never picked up again.
    for (const nothing of [null, "", "   "]) {
      expect(applyVerdict(piece("ROUGHING", "WAITING_QC"), "HOLD", nothing, sheet("ROUGHING"))).toEqual({
        ok: false,
        reason: "hold-needs-department",
      });
    }
  });

  it("trims the department name it stores", () => {
    const r = applyVerdict(piece("ROUGHING", "WAITING_QC"), "HOLD", "  Machining  ", sheet("ROUGHING"));
    expect(r.ok && r.next.holdDepartment).toBe("Machining");
  });
});

describe("coming back from rework", () => {
  it("returns to QC at the stage it was held in, never further on", () => {
    // Whatever failed is measured again before the piece moves anywhere.
    expect(applyReworkDone(at("ROUGHING", "WAITING_REWORK", "Machining"))).toEqual({
      ok: true,
      next: at("ROUGHING", "WAITING_QC"),
    });
    expect(applyReworkDone(at("FINISH", "WAITING_REWORK", "Grinding"))).toEqual({
      ok: true,
      next: at("FINISH", "WAITING_QC"),
    });
  });

  it("refuses to close a rework on a piece that is not in one", () => {
    expect(applyReworkDone(at("ROUGHING", "WAITING_QC"))).toEqual({
      ok: false,
      reason: "not-in-rework",
    });
    expect(applyReworkDone(at("FINISH", "CLOSED"))).toEqual({
      ok: false,
      reason: "not-in-rework",
    });
  });
});

describe("what cannot be done twice", () => {
  it("refuses a verdict on a piece that is not with QC", () => {
    // The guard that stops two inspectors deciding the same piece, and stops a
    // stale browser tab re-submitting a verdict after a rework has started.
    for (const state of ["WAITING_REWORK", "CLOSED"] as const) {
      expect(applyVerdict(piece("ROUGHING", state, "Machining"), "ACCEPTED", null, sheet("ROUGHING"))).toEqual({
        ok: false,
        reason: "not-with-qc",
      });
    }
  });
});

describe("a full route, held twice", () => {
  it("ends closed, having gone back to the same stage each time", () => {
    let p = initialPosition();
    // The round the piece is on. Every verdict moves it, exactly as the
    // transaction does, so each sheet below is the one the inspector would
    // actually have been looking at.
    let round = 0;

    const step = (fn: () => { ok: boolean; next?: PiecePosition }, counts = false) => {
      const r = fn();
      expect(r.ok).toBe(true);
      p = r.next!;
      if (counts) round += 1;
      return p;
    };
    const decide = (verdict: Parameters<typeof applyVerdict>[1], dept: string | null) =>
      step(() => applyVerdict({ ...p, round }, verdict, dept, { stage: p.stage, round }), true);

    expect(decide("HOLD", "Machining")).toEqual(at("ROUGHING", "WAITING_REWORK", "Machining"));
    expect(step(() => applyReworkDone(p))).toEqual(at("ROUGHING", "WAITING_QC"));
    expect(decide("ACCEPTED", null)).toEqual(at("FINISH", "WAITING_QC"));
    expect(decide("HOLD", "Grinding")).toEqual(at("FINISH", "WAITING_REWORK", "Grinding"));
    expect(step(() => applyReworkDone(p))).toEqual(at("FINISH", "WAITING_QC"));
    expect(decide("ACCEPTED_BYPASS", null)).toEqual(at("FINISH", "CLOSED"));
    expect(round).toBe(4);
  });
});

describe("two inspectors with the same piece open", () => {
  // The bug this closes: accepting at roughing sends a piece to finish, where
  // it is *also* waiting on QC. The old rule only asked whether the piece was
  // with QC, so the second inspector's roughing sheet was admitted and written
  // down as the finish inspection — a stage sign-off from readings taken
  // against a different drawing.

  it("refuses a sheet opened at a stage the piece has already left", () => {
    const moved = piece("FINISH", "WAITING_QC", null, 1);
    const stale = sheet("ROUGHING", 0);
    expect(applyVerdict(moved, "ACCEPTED", null, stale)).toEqual({
      ok: false,
      reason: "sheet-is-stale",
    });
  });

  it("refuses a sheet opened at the same stage but an earlier round", () => {
    // Held, reworked and back at roughing: same stage, but the sheet in the
    // second inspector's hand was written before any of that happened.
    const again = piece("ROUGHING", "WAITING_QC", null, 1);
    expect(applyVerdict(again, "HOLD", "Machining", sheet("ROUGHING", 0))).toEqual({
      ok: false,
      reason: "sheet-is-stale",
    });
  });

  it("admits the sheet that does describe the piece", () => {
    const now = piece("ROUGHING", "WAITING_QC", null, 3);
    expect(applyVerdict(now, "ACCEPTED", null, sheet("ROUGHING", 3))).toEqual({
      ok: true,
      next: at("FINISH", "WAITING_QC"),
    });
  });

  it("checks the sheet before anything else it could complain about", () => {
    // A stale sheet is not a verdict about this piece, so it is refused as
    // stale rather than as a missing department or a piece in rework — the
    // inspector needs to be told to reload, not to fill something in.
    const held = piece("ROUGHING", "WAITING_REWORK", "Machining", 2);
    expect(applyVerdict(held, "HOLD", null, sheet("ROUGHING", 0))).toEqual({
      ok: false,
      reason: "sheet-is-stale",
    });
  });
});

describe("what `Complete` means on the planning sheet", () => {
  it("is the opposite of waiting on QC, not of being finished", () => {
    // Planning's word. A piece in rework is complete as far as this sheet is
    // concerned: a decision was taken and it is somebody else's now.
    expect(isWithQc("WAITING_QC")).toBe(true);
    expect(isComplete("WAITING_QC")).toBe(false);
    expect(isComplete("WAITING_REWORK")).toBe(true);
    expect(isComplete("CLOSED")).toBe(true);
  });
});

describe("the route itself", () => {
  it("runs roughing then finish, and stops", () => {
    expect(nextStage("ROUGHING")).toBe("FINISH");
    expect(nextStage("FINISH")).toBeNull();
  });
});

describe("how long a piece waited on QC", () => {
  const t = (iso: string) => new Date(iso);

  it("adds the wait in progress to what was already settled", () => {
    const settled = 60 * 60 * 1000;
    const since = t("2026-09-12T10:00:00Z");
    expect(qcMillis(settled, since, t("2026-09-12T12:30:00Z"))).toBe(settled + 2.5 * 3600_000);
  });

  it("counts nothing while the piece is with a department", () => {
    // The figure is what QC took, not how long the piece was in the building.
    // Counting rework time against QC would make it say the opposite.
    expect(qcMillis(5000, null, t("2026-09-12T12:00:00Z"))).toBe(5000);
  });

  it("never goes backwards on a clock that disagrees", () => {
    // Browser time against server time: a few seconds of skew must not turn
    // into a negative duration on a report.
    expect(qcMillis(5000, t("2026-09-12T12:00:05Z"), t("2026-09-12T12:00:00Z"))).toBe(5000);
  });
});
