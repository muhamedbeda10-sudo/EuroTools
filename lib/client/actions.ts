"use client";

import {
  Timestamp,
  getDoc,
  getDocs,
  increment,
  query,
  runTransaction,
  setDoc,
  where,
  writeBatch,
  type Transaction,
} from "firebase/firestore";

import {
  applyReworkDone,
  applyVerdict,
  initialPosition,
  isVerdict,
  type PiecePosition,
  type Stage,
} from "@/lib/domain/workflow";
import { result, suggest, type Defect, type Reading } from "@/lib/domain/measurement";
import { allows, verdictPermission, type Permission } from "@/lib/domain/roles";
import { optionalNumber, optionalString } from "@/lib/format";
import { measuringType as parseMeasuringType, num, text } from "@/lib/import/parse";
import {
  CONFIG_DOCS,
  PHOTO_MAX_PER_INSPECTION,
  STAT_DOCS,
  configKey,
  toDate,
  type DefectEntry,
  type DefectSpec,
  type DimensionSpec,
  type InspectionDoc,
  type InspectionPhotoDataDoc,
  type InspectionPhotoDoc,
  type ItemConfigDoc,
  type LineCounts,
  type MeasuringType,
  type PieceDoc,
  type PlanningLineDoc,
  type ReadingEntry,
  type ReworkDoc,
} from "@/lib/model";
import { clientDb } from "@/lib/client/firebase";
import {
  config,
  docIn,
  inspections,
  itemConfigs,
  photoDataOf,
  photosOf,
  pieces,
  planningLines,
  reworks,
  stats,
  userAuditEvents,
  users,
} from "@/lib/client/db";
import { prepare } from "@/lib/client/photos";
import type { SessionUser } from "@/lib/client/session";

export interface ActionResult {
  ok: boolean;
  error?: string;
  info?: string;
}

/** Writing, from the browser.
 *
 *  ## Where the boundary actually is
 *
 *  Every permission check in this file runs on the operator's own machine and
 *  could be edited out of the bundle. They are here so somebody is told "you
 *  cannot do that" instead of watching a write fail with a Firestore error.
 *  They are courtesy, not control.
 *
 *  The control is `firestore.rules`, which runs on Google's side and re-reads
 *  the account's role for every operation. Read the note at the top of that
 *  file before changing anything here.
 *
 *  ## What is kept in step with what
 *
 *  A piece moving changes three things at once: the piece, the counters on its
 *  planning line, and the tallies the dashboard reads. All three are written
 *  in the transaction that moves it, so a report can never describe a state
 *  the pieces are not in.
 */

const now = () => Timestamp.now();

function allow(actor: SessionUser, permission: Permission): ActionResult | null {
  if (!allows(actor, permission))
    return { ok: false, error: "You do not have permission to do that." };
  return null;
}

function explain(error: unknown, fallback: string): ActionResult {
  const code = (error as { code?: string }).code ?? "";
  if (code.includes("permission-denied"))
    return {
      ok: false,
      error: "The system refused that. Check your permissions and the state of the record.",
    };
  if (code.includes("unavailable"))
    return { ok: false, error: "Could not reach the database. Check the connection." };
  const message = (error as Error)?.message;
  return { ok: false, error: message && message.length < 160 ? message : fallback };
}

/** What a move does to the counters on a planning line.
 *
 *  Written as one function because the three numbers have to agree with each
 *  other and with the pieces they count; working them out at each call site is
 *  how they stop agreeing.
 */
export function countDelta(
  from: PieceDoc["state"],
  to: PieceDoc["state"]
): Partial<Record<keyof LineCounts, number>> {
  if (from === to) return {};
  const field = { WAITING_QC: "withQc", WAITING_REWORK: "inRework", CLOSED: "closed" } as const;
  return { [field[from]]: -1, [field[to]]: 1 };
}

/** Move a piece, settling the time it spent waiting on quality.
 *
 *  The wait is accumulated rather than measured end to end: a piece held twice
 *  sits with a department in between, and counting that against quality would
 *  make the figure say the opposite of what it is for.
 */
function movePiece(
  tx: Transaction,
  pieceId: string,
  current: PieceDoc,
  next: PiecePosition,
  extra: Record<string, unknown> = {}
): void {
  const at = now();
  const leavingQc = current.state === "WAITING_QC" && next.state !== "WAITING_QC";
  const enteringQc = current.state !== "WAITING_QC" && next.state === "WAITING_QC";

  const waited = leavingQc
    ? Math.max(0, at.toMillis() - (toDate(current.qcSince)?.getTime() ?? at.toMillis()))
    : 0;

  tx.update(docIn(pieces(), pieceId), {
    stage: next.stage,
    state: next.state,
    holdDepartment: next.holdDepartment,
    qcSince: enteringQc ? at : leavingQc ? null : (current.qcSince ?? null),
    qcSettledMs: increment(waited),
    updatedAt: at,
    ...extra,
  });

  const delta = countDelta(current.state, next.state);
  if (Object.keys(delta).length > 0) {
    tx.update(
      docIn(planningLines(), current.lineId),
      Object.fromEntries(Object.entries(delta).map(([k, v]) => [`counts.${k}`, increment(v!)]))
    );
  }
}

/** The tallies the dashboard reads, incremented beside the record that caused
 *  them. A merge rather than an update, because the first inspection of a new
 *  department or defect is also the write that creates its line. */
function tally(tx: Transaction, docId: string, counts: Record<string, unknown>): void {
  if (Object.keys(counts).length === 0) return;
  tx.set(docIn(stats(), docId), { counts }, { merge: true });
}

// ───────────────────────── planning ─────────────────────────

/** One row as it arrives from the sheet, already parsed into values. The
 *  parsing itself is in `lib/import/planning.ts`, where it can be tested
 *  without a database. */
export interface PlanningInput {
  project: string;
  mplpr: string | null;
  itemCode: string;
  itemName: string;
  qty: number;
  measuringType: MeasuringType;
  priority: string | null;
  plannedAt: Date;
}

/** Firestore caps a batch at five hundred operations. A line costs one write
 *  plus one per piece, so a line of forty pieces is forty-one; committing per
 *  line keeps every batch far inside the limit and, more usefully, means a
 *  failure halfway through an import leaves whole lines rather than half of
 *  one. */
const MAX_QTY = 200;

/** Bring in planning's sheet.
 *
 *  A line and its pieces are created together: a line whose pieces failed to
 *  write would sit in the list with nothing to inspect, and a piece with no
 *  line has nothing to inspect it against. Re-importing a row that is already
 *  here is refused rather than duplicated — see `importKey`.
 */
export const importPlanning =
  (actor: SessionUser) =>
  async (rows: PlanningInput[]): Promise<ActionResult & { added?: number; skipped?: number }> => {
    const denied = allow(actor, "planning.manage");
    if (denied) return denied;
    if (rows.length === 0) return { ok: false, error: "That sheet has no rows to bring in." };

    let added = 0;
    let skipped = 0;

    try {
      for (const row of rows) {
        if (row.qty < 1 || row.qty > MAX_QTY)
          return { ok: false, error: `${row.project} ${row.itemCode}: quantity must be between 1 and ${MAX_QTY}.` };

        // The row's own identity, as planning wrote it. Importing the same
        // sheet twice is a thing that happens; creating the pieces twice is
        // not recoverable by hand.
        const lineId = importKey(row);
        const existing = await getDoc(docIn(planningLines(), lineId));
        if (existing.exists()) {
          skipped += 1;
          continue;
        }

        const batch = writeBatch(clientDb());
        const at = now();
        const plannedAt = Timestamp.fromDate(row.plannedAt);

        batch.set(docIn(planningLines(), lineId), {
          project: row.project,
          mplpr: row.mplpr,
          itemCode: row.itemCode,
          itemName: row.itemName,
          qty: row.qty,
          measuringType: row.measuringType,
          priority: row.priority,
          plannedAt,
          createdAt: at,
          updatedAt: at,
          createdByUid: actor.uid,
          createdByName: actor.displayName,
          counts: { total: row.qty, withQc: row.qty, inRework: 0, closed: 0, measurements: 0 },
        } satisfies PlanningLineDoc);

        const start = initialPosition();
        for (let n = 1; n <= row.qty; n += 1) {
          batch.set(docIn(pieces()), {
            lineId,
            project: row.project,
            itemCode: row.itemCode,
            itemName: row.itemName,
            measuringType: row.measuringType,
            priority: row.priority,
            plannedAt,
            pieceNo: n,
            serial: `${row.project}-${row.itemCode}-${String(n).padStart(3, "0")}`,
            stage: start.stage,
            state: start.state,
            holdDepartment: null,
            round: 0,
            measuredTimes: 0,
            lastVerdict: null,
            lastInspectedAt: null,
            // Quality owns it from the moment planning hands it over; that is
            // where the clock the dashboard reports starts.
            qcSince: at,
            qcSettledMs: 0,
            createdAt: at,
            updatedAt: at,
          } satisfies PieceDoc);
        }

        await batch.commit();
        added += 1;
      }
    } catch (error) {
      return {
        ...explain(error, "Could not bring in the sheet."),
        added,
        skipped,
      };
    }

    return {
      ok: true,
      added,
      skipped,
      info:
        `${added} line(s) brought in` +
        (skipped > 0 ? `, ${skipped} already here and left alone.` : "."),
    };
  };

/** A planning row's own identity: the same row imported twice lands on the
 *  same document and is recognised rather than duplicated. Project, item and
 *  planning's date are what make a row that row. */
export function importKey(row: Pick<PlanningInput, "project" | "itemCode" | "plannedAt">): string {
  const day = row.plannedAt.toISOString().slice(0, 10);
  return configKey(`${row.project}|${row.itemCode}|${day}`);
}

/** Cancel a line that has not been started.
 *
 *  Refused the moment any piece on it has been measured. A line with
 *  inspections against it is a record, and deleting it would leave signed
 *  sheets describing pieces that no longer exist.
 */
export const cancelPlanningLine =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "planning.manage");
    if (denied) return denied;

    const lineId = optionalString(formData.get("lineId"));
    if (!lineId) return { ok: false, error: "That line reference is not valid." };

    try {
      const [lineSnap, pieceSnap] = await Promise.all([
        getDoc(docIn(planningLines(), lineId)),
        getDocs(query(pieces(), where("lineId", "==", lineId))),
      ]);
      if (!lineSnap.exists()) return { ok: false, error: "That line no longer exists." };

      const started = pieceSnap.docs.filter((d) => (d.data() as PieceDoc).round > 0);
      if (started.length > 0)
        return {
          ok: false,
          error: `${started.length} piece(s) on this line have already been inspected, so it cannot be cancelled.`,
        };

      const batch = writeBatch(clientDb());
      for (const piece of pieceSnap.docs) batch.delete(piece.ref);
      batch.delete(lineSnap.ref);
      await batch.commit();
    } catch (error) {
      return explain(error, "Could not cancel the line.");
    }

    return { ok: true, info: "Line cancelled." };
  };

/** Correct a line that is already in.
 *
 *  What may be corrected here and what may not is not a matter of taste.
 *
 *  The line's document id is derived from its project, its item and its
 *  planned day — that is what makes importing the same sheet twice harmless
 *  instead of creating every piece a second time. Editing one of those three
 *  would leave the line sitting under an id that no longer describes it, and
 *  the next import of the same sheet would not recognise it and would bring it
 *  in again. So those three are not editable: changing them means cancelling
 *  the line and adding it again, which is what they actually are — a different
 *  line.
 *
 *  The quantity is editable only while nothing has been measured, for the same
 *  reason a line can only be cancelled then.
 *
 *  What the line says about the part is copied onto every piece when the
 *  pieces are made, so correcting it here corrects it there too, in one batch
 *  with the line. A name fixed on the line and stale on its pieces is how a
 *  report ends up disagreeing with the screen it was run from.
 */
export const updatePlanningLine =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "planning.manage");
    if (denied) return denied;

    const lineId = optionalString(formData.get("lineId"));
    if (!lineId) return { ok: false, error: "That line reference is not valid." };

    try {
      const [lineSnap, pieceSnap] = await Promise.all([
        getDoc(docIn(planningLines(), lineId)),
        getDocs(query(pieces(), where("lineId", "==", lineId))),
      ]);
      if (!lineSnap.exists()) return { ok: false, error: "That line no longer exists." };
      const line = lineSnap.data() as PlanningLineDoc;

      const itemName = text(formData.get("itemName")) ?? line.itemCode;
      const mplpr = text(formData.get("mplpr"));
      const priority = text(formData.get("priority"));

      const measuring = parseMeasuringType(formData.get("measuringType"));
      if (measuring == null)
        return { ok: false, error: "Measuring type has to be CMM or Traditional." };

      const qty = num(formData.get("qty"));
      if (qty == null || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY)
        return { ok: false, error: `Quantity must be a whole number between 1 and ${MAX_QTY}.` };

      const measured = line.counts.measurements > 0;
      if (qty !== line.qty && measured)
        return {
          ok: false,
          error:
            "This line has been measured, so its quantity is fixed. Add a new line for extra pieces.",
        };

      const batch = writeBatch(clientDb());
      const at = now();

      batch.update(lineSnap.ref, {
        mplpr,
        itemName,
        qty,
        measuringType: measuring,
        priority,
        "counts.total": qty,
        updatedAt: at,
      });

      // What the pieces were told about the part, brought back into step.
      const describes =
        itemName !== line.itemName ||
        measuring !== line.measuringType ||
        priority !== line.priority;
      if (describes) {
        for (const piece of pieceSnap.docs) {
          batch.update(piece.ref, {
            itemName,
            measuringType: measuring,
            priority,
            updatedAt: at,
          });
        }
      }

      // Pieces follow the quantity. Removing one is only ever removing one
      // nobody has touched, which the measured check above already guarantees;
      // the highest numbers go first so the serials left behind stay a run
      // from 001 with no gaps in it.
      if (qty > line.qty) {
        const plannedAt = line.plannedAt;
        const start = initialPosition();
        for (let n = line.qty + 1; n <= qty; n += 1) {
          batch.set(docIn(pieces()), {
            lineId,
            project: line.project,
            itemCode: line.itemCode,
            itemName,
            measuringType: measuring,
            priority,
            plannedAt,
            pieceNo: n,
            serial: `${line.project}-${line.itemCode}-${String(n).padStart(3, "0")}`,
            stage: start.stage,
            state: start.state,
            holdDepartment: null,
            round: 0,
            measuredTimes: 0,
            lastVerdict: null,
            lastInspectedAt: null,
            qcSince: at,
            qcSettledMs: 0,
            createdAt: at,
            updatedAt: at,
          } satisfies PieceDoc);
        }
      } else if (qty < line.qty) {
        for (const piece of pieceSnap.docs) {
          if ((piece.data() as PieceDoc).pieceNo > qty) batch.delete(piece.ref);
        }
      }

      // The counters the dashboard reads are kept beside the line rather than
      // counted, so a quantity change has to move them too.
      const added = Math.max(0, qty - line.qty);
      const removed = Math.max(0, line.qty - qty);
      if (added || removed) {
        batch.update(lineSnap.ref, { "counts.withQc": line.counts.withQc + added - removed });
      }

      await batch.commit();
    } catch (error) {
      return explain(error, "Could not save the line.");
    }

    return { ok: true, info: "Line saved." };
  };

// ───────────────────────── inspecting a piece ─────────────────────────

/** The readings posted from the sheet.
 *
 *  The drawing is posted alongside the reading rather than looked up again, so
 *  the record says what the inspector was working to. If the item's
 *  configuration is revised tomorrow, today's sheet still reads correctly —
 *  which is the whole reason a quality record copies its specification instead
 *  of pointing at one.
 */
function readReadings(formData: FormData): ReadingEntry[] {
  const keys = formData.getAll("readingKey").map(String);

  return keys.map((key, i) => {
    const spec: Reading = {
      key,
      name: String(formData.getAll("readingName")[i] ?? key),
      unit: optionalString(formData.getAll("readingUnit")[i]),
      nominal: optionalNumber(formData.getAll("readingNominal")[i]),
      tolMinus: optionalNumber(formData.getAll("readingTolMinus")[i]),
      tolPlus: optionalNumber(formData.getAll("readingTolPlus")[i]),
      actual: optionalNumber(formData.getAll("readingActual")[i]),
    };
    return {
      ...spec,
      unit: spec.unit ?? null,
      nominal: spec.nominal ?? null,
      tolMinus: spec.tolMinus ?? null,
      tolPlus: spec.tolPlus ?? null,
      actual: spec.actual ?? null,
      result: result(spec),
      adHoc: String(formData.getAll("readingAdHoc")[i] ?? "") === "1",
    };
  });
}

/** Only the defects actually ticked. An untouched checklist records nothing,
 *  rather than recording that every defect was absent — the sheet says what
 *  was seen, and a blank is not an observation. */
function readDefects(formData: FormData): DefectEntry[] {
  return formData
    .getAll("defectKey")
    .map(String)
    .map((key, i) => ({
      key,
      name: String(formData.getAll("defectName")[i] ?? key),
      department: optionalString(formData.getAll("defectDepartment")[i]),
      note: optionalString(formData.getAll("defectNote")[i]),
      seen: String(formData.getAll("defectSeen")[i] ?? "") === "1",
    }))
    .filter((d) => d.seen)
    .map((d) => ({ key: d.key, name: d.name, department: d.department, note: d.note }));
}

async function readPhotos(formData: FormData) {
  const files = formData
    .getAll("photos")
    .filter((f): f is File => f instanceof File && f.size > 0);

  if (files.length > PHOTO_MAX_PER_INSPECTION)
    throw new Error(`At most ${PHOTO_MAX_PER_INSPECTION} photographs per inspection.`);

  return Promise.all(files.map((file) => prepare(file)));
}

/** Measure a piece and decide what happens to it.
 *
 *  One transaction writes the sheet, moves the piece, adjusts the line's
 *  counters, opens a rework when it is held, and updates the tallies the
 *  dashboard reads. Anything less and a report can describe a state the pieces
 *  are not in.
 */
export const recordInspection =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "inspection.record");
    if (denied) return denied;

    const pieceId = optionalString(formData.get("pieceId"));
    const verdict = String(formData.get("verdict") ?? "");
    const department = optionalString(formData.get("holdDepartment"));
    const bypassReason = optionalString(formData.get("bypassReason"));

    if (!pieceId) return { ok: false, error: "That piece reference is not valid." };
    if (!isVerdict(verdict)) return { ok: false, error: "Choose a verdict." };

    const readings = readReadings(formData);
    const defects = readDefects(formData);
    const suggestion = suggest(readings as Reading[], defects as Defect[]);

    // A concession is the one verdict nothing arrives at on its own, so it is
    // the one the permission sits on.
    const verdictDenied = allow(actor, verdictPermission(verdict, suggestion.verdict));
    if (verdictDenied)
      return {
        ok: false,
        error:
          "Letting through a piece the measurements hold needs a concession, and your account cannot grant one.",
      };
    if (verdict === "ACCEPTED_BYPASS" && !bypassReason)
      return { ok: false, error: "A concession has to say why. Write the reason before signing." };

    let photos;
    try {
      photos = await readPhotos(formData);
    } catch (error) {
      return { ok: false, error: String((error as Error)?.message ?? "Could not process the photographs.") };
    }

    try {
      await runTransaction(clientDb(), async (tx) => {
        const ref = docIn(pieces(), pieceId);
        const snapshot = await tx.get(ref);
        if (!snapshot.exists()) throw new Error("That piece no longer exists.");
        const piece = snapshot.data() as PieceDoc;

        const move = applyVerdict(
          { stage: piece.stage, state: piece.state, holdDepartment: piece.holdDepartment },
          verdict,
          verdict === "HOLD" ? department : null
        );
        if (!move.ok) throw new Error(transitionMessage(move.reason));

        const round = (piece.round ?? 0) + 1;
        const at = now();
        const inspectionRef = docIn(inspections());

        tx.set(inspectionRef, {
          pieceId,
          lineId: piece.lineId,
          project: piece.project,
          itemCode: piece.itemCode,
          itemName: piece.itemName,
          serial: piece.serial,
          stage: piece.stage,
          round,
          readings,
          defects,
          suggested: suggestion.verdict,
          verdict,
          holdDepartment: move.next.holdDepartment,
          bypassReason: verdict === "ACCEPTED_BYPASS" ? bypassReason : null,
          inspectorUid: actor.uid,
          inspector: actor.displayName,
          inspectedAt: at,
          photoCount: photos.length,
          hasFailedReading: readings.some((r) => r.result === "FAIL"),
        } satisfies InspectionDoc);

        // Evidence and verdict commit together. A photograph that outlived the
        // sheet it was taken for would be a photograph of nothing.
        for (const photo of photos) {
          const photoId = docIn(photosOf(inspectionRef.id)).id;
          tx.set(docIn(photosOf(inspectionRef.id), photoId), {
            thumb: photo.thumb,
            caption: null,
            width: photo.width,
            height: photo.height,
            bytes: photo.bytes,
            capturedAt: at,
            capturedByUid: actor.uid,
            capturedByName: actor.displayName,
          } satisfies InspectionPhotoDoc);
          tx.set(docIn(photoDataOf(inspectionRef.id), photoId), {
            data: photo.data,
          } satisfies InspectionPhotoDataDoc);
        }

        movePiece(tx, pieceId, piece, move.next, {
          // The round counts measurements at the stage the piece is at, so it
          // starts again when the piece moves on: "held three times at finish"
          // then reads directly off the piece.
          round: move.next.stage === piece.stage ? round : 0,
          // Never reset: this is the number planning asks for in their
          // Description column — how many times the thing had to be measured.
          measuredTimes: increment(1),
          lastVerdict: verdict,
          lastInspectedAt: at,
        });

        tx.update(docIn(planningLines(), piece.lineId), {
          "counts.measurements": increment(1),
        });

        if (verdict === "HOLD" && move.next.holdDepartment) {
          tx.set(docIn(reworks()), {
            pieceId,
            lineId: piece.lineId,
            project: piece.project,
            itemCode: piece.itemCode,
            serial: piece.serial,
            stage: piece.stage,
            round,
            inspectionId: inspectionRef.id,
            department: move.next.holdDepartment,
            heldAt: at,
            heldByUid: actor.uid,
            heldByName: actor.displayName,
            completedAt: null,
            recordedByUid: null,
            recordedByName: null,
            note: null,
          } satisfies ReworkDoc);
        }

        tx.update(docIn(users(), actor.uid), { signedInspections: increment(1) });

        tally(tx, STAT_DOCS.verdicts, {
          [verdict]: increment(1),
          [`${piece.stage}::${verdict}`]: increment(1),
        });
        if (move.next.holdDepartment)
          tally(tx, STAT_DOCS.holds, {
            [move.next.holdDepartment]: increment(1),
            [`${move.next.holdDepartment}::${piece.stage}`]: increment(1),
          });
        tally(
          tx,
          STAT_DOCS.defects,
          Object.fromEntries(defects.map((d) => [d.key, increment(1)]))
        );
      });
    } catch (error) {
      return explain(error, "Could not record the inspection.");
    }

    return {
      ok: true,
      info:
        verdict === "HOLD"
          ? `Held for ${department}. It stays at this stage until the rework is closed out.`
          : "Recorded. The piece has moved on.",
    };
  };

function transitionMessage(reason: string): string {
  if (reason === "not-with-qc")
    return "This piece is not waiting on quality — somebody else has already moved it. Reload the page.";
  if (reason === "hold-needs-department")
    return "A hold has to name the department that will put it right.";
  return "A department cannot be recorded against a piece that was accepted.";
}

// ───────────────────────── rework ─────────────────────────

/** Record that the department has finished.
 *
 *  Quality enters this on the department's behalf — that is how the plant
 *  works, and the record says so plainly by keeping both names: who held the
 *  piece, and who is reporting that the work is done.
 */
export const recordReworkDone =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "rework.record");
    if (denied) return denied;

    const pieceId = optionalString(formData.get("pieceId"));
    const note = optionalString(formData.get("note"));
    if (!pieceId) return { ok: false, error: "That piece reference is not valid." };

    try {
      await runTransaction(clientDb(), async (tx) => {
        const snapshot = await tx.get(docIn(pieces(), pieceId));
        if (!snapshot.exists()) throw new Error("That piece no longer exists.");
        const piece = snapshot.data() as PieceDoc;

        const move = applyReworkDone({
          stage: piece.stage,
          state: piece.state,
          holdDepartment: piece.holdDepartment,
        });
        if (!move.ok) throw new Error("That piece is not in rework.");

        movePiece(tx, pieceId, piece, move.next);
      });

      // Closing the open rework record is a second write on purpose: it needs
      // a query to find, and a transaction may not query. It is a report of
      // when the work finished, not part of where the piece is, so a failure
      // here leaves the piece correctly back with quality.
      const open = await getDocs(
        query(reworks(), where("pieceId", "==", pieceId), where("completedAt", "==", null))
      );
      const batch = writeBatch(clientDb());
      for (const d of open.docs)
        batch.update(d.ref, {
          completedAt: now(),
          recordedByUid: actor.uid,
          recordedByName: actor.displayName,
          note,
        });
      if (open.docs.length > 0) await batch.commit();
    } catch (error) {
      return explain(error, "Could not close out the rework.");
    }

    return { ok: true, info: "Back with quality. Measure it again to decide." };
  };

// ───────────────────────── configuration ─────────────────────────

/** The departments a hold may name.
 *
 *  A free-text department would make the dashboard useless within a month:
 *  "Machining", "machining" and "M/C shop" are three columns describing one
 *  place. The list is short, an administrator owns it, and everything else
 *  chooses from it.
 */
export const saveDepartments =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "config.manage");
    if (denied) return denied;

    const list = String(formData.get("departments") ?? "")
      .split(/[\n,]/)
      .map((d) => d.trim())
      .filter(Boolean);

    const seen = new Set<string>();
    const unique = list.filter((d) => {
      const k = d.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (unique.length === 0)
      return { ok: false, error: "At least one department is needed — a hold has to name somebody." };

    try {
      await setDoc(docIn(config(), CONFIG_DOCS.departments), { list: unique });
    } catch (error) {
      return explain(error, "Could not save the departments.");
    }
    return { ok: true, info: `${unique.length} department(s) saved.` };
  };

/** The defects every item starts from. An item with none of its own still
 *  gives the inspector something to tick, which is the difference between a
 *  defect being recorded and being remembered. */
export const saveDefectCatalogue =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "config.manage");
    if (denied) return denied;

    const list = readDefectSpecs(formData);
    try {
      await setDoc(docIn(config(), CONFIG_DOCS.defects), { list });
    } catch (error) {
      return explain(error, "Could not save the defect list.");
    }
    return { ok: true, info: `${list.length} defect(s) saved.` };
  };

function readDefectSpecs(formData: FormData): DefectSpec[] {
  return formData
    .getAll("defectName")
    .map(String)
    .map((name, i) => ({
      // A stored key never changes when a label is re-worded: the tallies are
      // keyed by it, and re-wording a line must not orphan its history.
      key: optionalString(formData.getAll("defectKey")[i]) ?? slug(name),
      name: name.trim(),
      department: optionalString(formData.getAll("defectDepartment")[i]),
    }))
    .filter((d) => d.name.length > 0);
}

function readDimensionSpecs(formData: FormData, stage: Stage): DimensionSpec[] {
  const prefix = stage.toLowerCase();
  return formData
    .getAll(`${prefix}Name`)
    .map(String)
    .map((name, i) => ({
      key: optionalString(formData.getAll(`${prefix}Key`)[i]) ?? slug(name),
      name: name.trim(),
      unit: optionalString(formData.getAll(`${prefix}Unit`)[i]),
      nominal: optionalNumber(formData.getAll(`${prefix}Nominal`)[i]) ?? null,
      tolMinus: optionalNumber(formData.getAll(`${prefix}TolMinus`)[i]) ?? null,
      tolPlus: optionalNumber(formData.getAll(`${prefix}TolPlus`)[i]) ?? null,
    }))
    .filter((d) => d.name.length > 0);
}

/** A stable key from a label. Lower case, words joined by underscores, so the
 *  same dimension typed twice with different capitalisation is one key. */
export function slug(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9؀-ۿ]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unnamed"
  );
}

/** What an item has to be: its dimensions at each stage, and the defects to
 *  look for. Saved whole, because a dimension removed from the sheet has to
 *  disappear from the next inspection, not linger. Sheets already signed keep
 *  their own copy and are unaffected. */
export const saveItemConfig =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "config.manage");
    if (denied) return denied;

    const itemCode = optionalString(formData.get("itemCode"));
    const itemName = optionalString(formData.get("itemName"));
    if (!itemCode) return { ok: false, error: "An item code is required." };

    const doc: ItemConfigDoc = {
      itemCode,
      itemName: itemName ?? itemCode,
      dimensions: {
        ROUGHING: readDimensionSpecs(formData, "ROUGHING"),
        FINISH: readDimensionSpecs(formData, "FINISH"),
      },
      defects: readDefectSpecs(formData),
      updatedAt: now(),
      updatedByUid: actor.uid,
      updatedByName: actor.displayName,
    };

    try {
      await setDoc(docIn(itemConfigs(), configKey(itemCode)), doc);
    } catch (error) {
      return explain(error, "Could not save the item.");
    }
    return { ok: true, info: `${itemCode} saved.` };
  };

export const deleteItemConfig =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "config.manage");
    if (denied) return denied;

    const itemCode = optionalString(formData.get("itemCode"));
    if (!itemCode) return { ok: false, error: "An item code is required." };

    try {
      const batch = writeBatch(clientDb());
      batch.delete(docIn(itemConfigs(), configKey(itemCode)));
      await batch.commit();
    } catch (error) {
      return explain(error, "Could not remove the item.");
    }
    // Sheets already signed keep their own copy of the drawing, so nothing
    // historical changes. Only the next inspection does.
    return { ok: true, info: `${itemCode} removed. Sheets already signed are unchanged.` };
  };

/** One dimension row as it arrives from the configuration sheet. */
export interface DimensionInput {
  itemCode: string;
  itemName: string | null;
  stage: Stage;
  name: string;
  unit: string | null;
  nominal: number | null;
  tolMinus: number | null;
  tolPlus: number | null;
}

/** One defect row as it arrives from the configuration sheet. */
export interface DefectInput {
  itemCode: string | null;
  name: string;
  department: string | null;
}

/** Bring in dimensions and defects for many items at once.
 *
 *  Grouped by item and written one document per item, so a sheet covering
 *  forty items is forty writes rather than four hundred. An item already
 *  configured is replaced: the sheet is the source, and merging would leave
 *  dimensions somebody deleted from it still being measured.
 */
export const importItemConfigs =
  (actor: SessionUser) =>
  async (
    dimensions: DimensionInput[],
    defects: DefectInput[]
  ): Promise<ActionResult & { items?: number }> => {
    const denied = allow(actor, "config.manage");
    if (denied) return denied;
    if (dimensions.length === 0 && defects.length === 0)
      return { ok: false, error: "That sheet has nothing to bring in." };

    const byItem = new Map<string, ItemConfigDoc>();
    const blank = (itemCode: string, itemName: string | null): ItemConfigDoc => ({
      itemCode,
      itemName: itemName ?? itemCode,
      dimensions: { ROUGHING: [], FINISH: [] },
      defects: [],
      updatedAt: now(),
      updatedByUid: actor.uid,
      updatedByName: actor.displayName,
    });

    for (const row of dimensions) {
      const item = byItem.get(row.itemCode) ?? blank(row.itemCode, row.itemName);
      if (row.itemName) item.itemName = row.itemName;
      item.dimensions[row.stage].push({
        key: slug(row.name),
        name: row.name.trim(),
        unit: row.unit,
        nominal: row.nominal,
        tolMinus: row.tolMinus,
        tolPlus: row.tolPlus,
      });
      byItem.set(row.itemCode, item);
    }

    // A defect row with no item code belongs to every item, so it goes to the
    // catalogue rather than to one of them.
    const catalogue: DefectSpec[] = [];
    for (const row of defects) {
      const spec = { key: slug(row.name), name: row.name.trim(), department: row.department };
      if (!row.itemCode) {
        catalogue.push(spec);
        continue;
      }
      const item = byItem.get(row.itemCode) ?? blank(row.itemCode, null);
      item.defects.push(spec);
      byItem.set(row.itemCode, item);
    }

    try {
      const batch = writeBatch(clientDb());
      for (const [itemCode, item] of byItem)
        batch.set(docIn(itemConfigs(), configKey(itemCode)), item);
      if (catalogue.length > 0) batch.set(docIn(config(), CONFIG_DOCS.defects), { list: catalogue });
      await batch.commit();
    } catch (error) {
      return explain(error, "Could not bring in the configuration.");
    }

    return {
      ok: true,
      items: byItem.size,
      info:
        `${byItem.size} item(s) configured` +
        (catalogue.length > 0 ? `, and ${catalogue.length} defect(s) added to the shared list.` : "."),
    };
  };

// ───────────────────────── accounts ─────────────────────────

/** Add somebody: a sign-in and the access that goes with it.
 *
 *  Two writes that have to be thought of as one. The Firebase account is what
 *  lets them sign in; the document here is what lets them do anything, and
 *  without it they sign in successfully and read nothing at all. If the second
 *  fails the first is left behind — a sign-in with no access, which is the
 *  safe half to be stranded with, and is recoverable by adding the person
 *  again with the same address.
 */
export const grantAccess =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "user.manage");
    if (denied) return denied;

    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const displayName = String(formData.get("displayName") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    const role = String(formData.get("role") ?? "").trim();
    const employeeNo = optionalString(formData.get("employeeNo"));
    const granted = formData.getAll("granted").map(String);
    const denyList = formData.getAll("denied").map(String);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return { ok: false, error: "That email address is not valid." };
    if (!displayName)
      return { ok: false, error: "A name is required. It is the name that signs every inspection." };
    if (password.length < 8)
      return { ok: false, error: "The starting password must be at least 8 characters." };

    const { isRole } = await import("@/lib/domain/roles");
    if (!isRole(role)) return { ok: false, error: "Unknown role." };

    const { createSignIn } = await import("@/lib/client/provision");
    const signIn = await createSignIn(email, password, displayName);
    if (!signIn.ok) return { ok: false, error: signIn.error };

    try {
      const at = now();
      const batch = writeBatch(clientDb());

      batch.set(docIn(users(), signIn.uid), {
        email,
        displayName,
        role,
        granted,
        denied: denyList,
        employeeNo,
        active: true,
        createdAt: at,
        updatedAt: at,
        createdByUid: actor.uid,
        createdByName: actor.displayName,
        signedInspections: 0,
      });

      batch.set(docIn(userAuditEvents()), {
        at,
        kind: "CREATED",
        subjectUid: signIn.uid,
        subjectName: displayName,
        actorUid: actor.uid,
        actorName: actor.displayName,
        fromValue: null,
        toValue: role,
      });

      await batch.commit();
    } catch (error) {
      return explain(
        error,
        "The sign-in was created but the account was not. Add the person again with the same address."
      );
    }

    return {
      ok: true,
      info: `${displayName} can sign in with ${email}. Hand them the password and ask them to change it.`,
    };
  };

/** What one person may do, beyond or short of their role. */
export const setUserPermissions =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "user.manage");
    if (denied) return denied;

    const uid = optionalString(formData.get("uid"));
    if (!uid) return { ok: false, error: "That account reference is not valid." };
    if (uid === actor.uid)
      return {
        ok: false,
        error: "You cannot change your own permissions. Another administrator has to.",
      };

    const granted = formData.getAll("granted").map(String);
    const denyList = formData.getAll("denied").map(String);

    try {
      const snapshot = await getDoc(docIn(users(), uid));
      if (!snapshot.exists()) return { ok: false, error: "That account no longer exists." };
      const subject = snapshot.data() as { displayName: string };

      const at = now();
      const batch = writeBatch(clientDb());
      batch.update(docIn(users(), uid), { granted, denied: denyList, updatedAt: at });
      batch.set(docIn(userAuditEvents()), {
        at,
        kind: "ROLE_CHANGED",
        subjectUid: uid,
        subjectName: subject.displayName,
        actorUid: actor.uid,
        actorName: actor.displayName,
        fromValue: null,
        toValue: [
          granted.length > 0 ? `+${granted.join(", ")}` : "",
          denyList.length > 0 ? `-${denyList.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" ") || "no exceptions",
      });
      await batch.commit();
    } catch (error) {
      return explain(error, "Could not save the permissions.");
    }

    return { ok: true, info: "Permissions saved." };
  };

export const setUserRole =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "user.manage");
    if (denied) return denied;

    const uid = optionalString(formData.get("id"));
    const role = String(formData.get("role") ?? "").trim();
    if (!uid) return { ok: false, error: "That reference is not valid." };

    const { ROLES, isRole } = await import("@/lib/domain/roles");
    if (!isRole(role)) return { ok: false, error: `The role must be one of: ${ROLES.join(", ")}` };
    if (uid === actor.uid)
      return { ok: false, error: "You cannot change your own role. Another administrator has to." };

    const snapshot = await getDoc(docIn(users(), uid));
    if (!snapshot.exists()) return { ok: false, error: "That account no longer exists." };
    const subject = snapshot.data() as { role: string; active: boolean; displayName: string };
    if (subject.role === role) return { ok: true, info: "Nothing changed." };

    if (role !== "ADMIN") {
      const refusal = await lastAdminRefusal(subject);
      if (refusal) return { ok: false, error: refusal };
    }

    try {
      const batch = writeBatch(clientDb());
      batch.update(docIn(users(), uid), { role, updatedAt: now() });
      batch.set(docIn(userAuditEvents()), {
        at: now(),
        kind: "ROLE_CHANGED",
        subjectUid: uid,
        subjectName: subject.displayName,
        actorUid: actor.uid,
        actorName: actor.displayName,
        fromValue: subject.role,
        toValue: role,
      });
      await batch.commit();
    } catch (error) {
      return explain(error, "Could not change the role.");
    }

    return { ok: true, info: `${subject.displayName}'s role has changed.` };
  };

export const setUserActive =
  (actor: SessionUser) =>
  async (formData: FormData): Promise<ActionResult> => {
    const denied = allow(actor, "user.manage");
    if (denied) return denied;

    const uid = optionalString(formData.get("id"));
    const active = formData.get("active") === "true";
    if (!uid) return { ok: false, error: "That reference is not valid." };

    const snapshot = await getDoc(docIn(users(), uid));
    if (!snapshot.exists()) return { ok: false, error: "That account no longer exists." };
    const subject = snapshot.data() as { role: string; active: boolean; displayName: string };
    if (subject.active === active) return { ok: true, info: "Nothing changed." };

    if (!active) {
      if (uid === actor.uid)
        return { ok: false, error: "You cannot deactivate your own account. Another administrator has to." };
      const refusal = await lastAdminRefusal(subject);
      if (refusal) return { ok: false, error: refusal };
    }

    try {
      const batch = writeBatch(clientDb());
      batch.update(docIn(users(), uid), { active, updatedAt: now() });
      batch.set(docIn(userAuditEvents()), {
        at: now(),
        kind: active ? "ACTIVATED" : "DEACTIVATED",
        subjectUid: uid,
        subjectName: subject.displayName,
        actorUid: actor.uid,
        actorName: actor.displayName,
        fromValue: String(subject.active),
        toValue: String(active),
      });
      await batch.commit();
    } catch (error) {
      return explain(error, "Could not change the account's state.");
    }

    return {
      ok: true,
      info: active
        ? `${subject.displayName} is active again.`
        : `${subject.displayName} is deactivated, and is refused from their next request onwards.`,
    };
  };

/** Would this change leave nobody able to administer the system?
 *
 *  Stated separately from the self-edit rule even though that rule implies it
 *  today, so the invariant survives a change to it. A count aggregation rather
 *  than a read of the staff list: exact, and one read whatever the headcount.
 */
async function lastAdminRefusal(subject: {
  role: string;
  active: boolean;
}): Promise<string | null> {
  if (subject.role !== "ADMIN" || !subject.active) return null;

  const { getCountFromServer } = await import("firebase/firestore");
  const others = await getCountFromServer(
    query(users(), where("role", "==", "ADMIN"), where("active", "==", true))
  );
  // The subject is still counted here, so "only them" reads as one.
  if (others.data().count <= 1) return "This is the only active administrator. Appoint another one first.";
  return null;
}
