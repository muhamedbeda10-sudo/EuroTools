/** Where a piece is, and what a verdict does to it.
 *
 *  Pure: no I/O, no Firestore, no dates read from the clock. The same
 *  functions decide a transition in the browser before the inspector commits
 *  it and in the tests that pin this file, so what is previewed and what is
 *  stored cannot drift apart.
 *
 *  The route is short and the whole system turns on it:
 *
 *      planning drops a line ──▶ every piece: ROUGHING, waiting on QC
 *
 *      QC measures and decides
 *        ├─ HOLD             ──▶ same stage, waiting on a department
 *        ├─ ACCEPTED         ──▶ ROUGHING becomes FINISH, still waiting on QC
 *        └─ ACCEPTED_BYPASS  ──▶ the same move, on a concession
 *
 *      the department finishes the rework
 *                            ──▶ same stage, waiting on QC again, next round
 *
 *      accepted at FINISH    ──▶ closed
 */

export const STAGES = ["ROUGHING", "FINISH"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  ROUGHING: "Roughing",
  FINISH: "Finish",
};

export const VERDICTS = ["HOLD", "ACCEPTED", "ACCEPTED_BYPASS"] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_LABELS: Record<Verdict, string> = {
  HOLD: "Hold",
  ACCEPTED: "Accepted",
  ACCEPTED_BYPASS: "Accepted (bypass)",
};

/** Where a piece is waiting, which is the same question as whose desk it is
 *  on. Nothing else about a piece changes who has to act next. */
export const PIECE_STATES = ["WAITING_QC", "WAITING_REWORK", "CLOSED"] as const;
export type PieceState = (typeof PIECE_STATES)[number];

export const STATE_LABELS: Record<PieceState, string> = {
  WAITING_QC: "Waiting on QC",
  WAITING_REWORK: "In rework",
  CLOSED: "Closed",
};

export interface PiecePosition {
  stage: Stage;
  state: PieceState;
  /** The department that has to fix it, while it is in rework. */
  holdDepartment: string | null;
}

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}

/** Where a piece starts: at the first stage, on QC's desk. */
export function initialPosition(): PiecePosition {
  return { stage: STAGES[0], state: "WAITING_QC", holdDepartment: null };
}

/** True while the line is QC's to act on. `Complete`, as the planning sheet
 *  uses the word, is the opposite of this: a decision has been taken and the
 *  piece is somebody else's problem now, whether that is a department doing
 *  rework or nobody at all. */
export function isWithQc(state: PieceState): boolean {
  return state === "WAITING_QC";
}

export const isComplete = (state: PieceState) => !isWithQc(state);

/** The stage after this one, or null at the end of the route. */
export function nextStage(stage: Stage): Stage | null {
  const at = STAGES.indexOf(stage);
  return at < 0 || at === STAGES.length - 1 ? null : STAGES[at + 1];
}

export type TransitionError =
  | "not-with-qc"
  | "hold-needs-department"
  | "department-on-acceptance";

/** What a verdict does to a piece.
 *
 *  A hold names the department that has to act, because a hold with nobody
 *  attached is a piece that stops and is never picked up again. An acceptance
 *  names nobody, for the same reason in reverse: a department recorded against
 *  a piece that was accepted would appear in the rework figures having done no
 *  rework.
 */
export function applyVerdict(
  position: PiecePosition,
  verdict: Verdict,
  department: string | null
): { ok: true; next: PiecePosition } | { ok: false; reason: TransitionError } {
  if (position.state !== "WAITING_QC") return { ok: false, reason: "not-with-qc" };

  if (verdict === "HOLD") {
    if (!department?.trim()) return { ok: false, reason: "hold-needs-department" };
    return {
      ok: true,
      next: { stage: position.stage, state: "WAITING_REWORK", holdDepartment: department.trim() },
    };
  }

  if (department?.trim()) return { ok: false, reason: "department-on-acceptance" };

  const onwards = nextStage(position.stage);
  return {
    ok: true,
    next: onwards
      ? // Accepted at roughing: it moves to finish and waits for QC there. The
        // machining in between is not tracked here — QC measures it when it
        // comes back, and until then the finish queue shows it as waiting.
        { stage: onwards, state: "WAITING_QC", holdDepartment: null }
      : { stage: position.stage, state: "CLOSED", holdDepartment: null },
  };
}

/** The department has finished; the piece comes back to QC at the same stage
 *  it was held in. It never moves forward on a rework: whatever failed is
 *  measured again before anything else happens to it. */
export function applyReworkDone(
  position: PiecePosition
): { ok: true; next: PiecePosition } | { ok: false; reason: "not-in-rework" } {
  if (position.state !== "WAITING_REWORK") return { ok: false, reason: "not-in-rework" };
  return {
    ok: true,
    next: { stage: position.stage, state: "WAITING_QC", holdDepartment: null },
  };
}

/** How long a piece has sat with QC, in milliseconds.
 *
 *  Accumulated rather than measured end to end. A piece held twice waits on a
 *  department in between, and counting that against QC would make the figure
 *  say the opposite of what it is for. `since` is when the current wait began,
 *  and is null whenever the piece is not with QC.
 */
export function qcMillis(
  settled: number,
  since: Date | null | undefined,
  now: Date
): number {
  if (!since) return settled;
  return settled + Math.max(0, now.getTime() - since.getTime());
}
