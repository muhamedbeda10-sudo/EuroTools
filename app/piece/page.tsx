"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { Async } from "@/components/Async";
import { InlineForm } from "@/components/InlineForm";
import { InspectionSheet } from "@/components/InspectionSheet";
import { PhotoGallery } from "@/components/PhotoGallery";
import { PrintButton } from "@/components/PrintButton";
import { Card, Empty, Kv, PageHeader, StatusPill } from "@/components/ui";
import { can } from "@/lib/domain/roles";
import { STAGES, STAGE_LABELS } from "@/lib/domain/workflow";
import { fmtDate, fmtDateTime, fmtDuration, fmtNum } from "@/lib/format";
import { recordInspection, recordReworkDone } from "@/lib/client/actions";
import { getPiece } from "@/lib/client/queries";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession } from "@/lib/client/session";

/** One piece: where it is, what it was measured against every time it has been
 *  here, and the sheet to measure it again. */
function PieceView({ id }: { id: string }) {
  const me = useRequireSession();
  const state = useAsync(() => getPiece(id), [id]);
  if (!me) return null;

  return (
    <Async state={state} empty={<Empty>That piece does not exist.</Empty>}>
      {(d) => (
        <>
          <PageHeader
            title={`Piece ${d.piece.serial}`}
            subtitle={`${d.piece.project} · ${d.piece.itemName}`}
          />

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <PrintButton />
            <StatusPill status={d.piece.stage} />
            <StatusPill status={d.piece.state} />
            {d.piece.holdDepartment && (
              <span className="pill pill-warn">with {d.piece.holdDepartment}</span>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Piece">
              <Kv k="Serial" v={<span className="ltr">{d.piece.serial}</span>} />
              <Kv k="Project" v={<span className="ltr">{d.piece.project}</span>} />
              <Kv k="Item" v={<span className="ltr">{d.piece.itemCode}</span>} />
              <Kv k="Name" v={d.piece.itemName} />
              <Kv k="Piece" v={<span className="num">{d.piece.pieceNo}</span>} />
              <Kv k="Priority" v={<span className="ltr">{d.piece.priority ?? "—"}</span>} />
              <Kv k="Measuring" v={d.piece.measuringType === "CMM" ? "CMM" : "Traditional"} />
              <Kv k="Planned" v={<span className="num">{fmtDate(d.piece.plannedAt)}</span>} />
              <Kv k="With quality" v={<span className="num">{fmtDuration(d.piece.qcMs)}</span>} />
              {d.line?.mplpr && <Kv k="MPLPR" v={<span className="ltr">{d.line.mplpr}</span>} />}
              <Kv
                k="Times measured"
                v={<span className="num">{d.piece.measuredTimes}</span>}
              />
            </Card>

            <div className="min-w-0 lg:col-span-2" id="measure">
              {d.piece.state === "WAITING_QC" && can(me.role, "inspection.record") ? (
                <Card
                  title={`Measure — ${STAGE_LABELS[d.piece.stage]}`}
                  subtitle={
                    d.piece.round > 0
                      ? `Round ${d.piece.round + 1}. It has been here ${d.piece.round} time(s) before.`
                      : "First time at this stage."
                  }
                >
                  <InspectionSheet
                    me={me}
                    pieceId={d.piece.id}
                    serial={d.piece.serial}
                    stage={d.piece.stage}
                    round={d.piece.round}
                    dimensions={d.dimensions}
                    defects={d.defects}
                    departments={d.departments}
                    itemConfigured={d.itemConfigured}
                    action={recordInspection(me)}
                    onSuccess={state.refresh}
                  />
                </Card>
              ) : d.piece.state === "WAITING_REWORK" ? (
                <Card title="In rework" subtitle={`Held against ${d.piece.holdDepartment}`}>
                  <p className="text-sm">
                    This piece stays at {STAGE_LABELS[d.piece.stage]} until the rework is done. When
                    the department reports back, close it out here and measure it again.
                  </p>
                  {can(me.role, "rework.record") && (
                    <div className="mt-3">
                      <InlineForm
                        action={recordReworkDone(me)}
                        onSuccess={state.refresh}
                        submitLabel="The rework is done"
                        confirm={`${d.piece.holdDepartment} has finished the rework on ${d.piece.serial}?`}
                      >
                        <input type="hidden" name="pieceId" value={d.piece.id} />
                        <input
                          className="input mb-2"
                          name="note"
                          placeholder="What they did (optional)"
                        />
                      </InlineForm>
                    </div>
                  )}
                </Card>
              ) : (
                <Card title="Closed">
                  <p className="text-sm">
                    This piece has been through {STAGES.map((s) => STAGE_LABELS[s]).join(" and ")},
                    and was accepted at the end.
                  </p>
                </Card>
              )}
            </div>
          </div>

          {/* ── every time it has been measured ── */}
          <Card className="mt-4 page-break" title="Measurement history">
            {d.history.length === 0 ? (
              <Empty>This piece has not been measured yet.</Empty>
            ) : (
              <div className="grid gap-4">
                {d.history.map((insp) => (
                  <div
                    key={insp.id}
                    className="rounded-[var(--radius-sm)] border border-[var(--border)] p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-bold">
                          {STAGE_LABELS[insp.stage]} · round {insp.round}
                        </div>
                        <div className="text-xs text-[var(--muted)]">
                          {insp.inspector} · {fmtDateTime(insp.inspectedAt)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {insp.verdict !== insp.suggested && (
                          <span className="pill pill-warn">differs from the evidence</span>
                        )}
                        <StatusPill status={insp.verdict} />
                      </div>
                    </div>

                    {insp.bypassReason && (
                      <p className="mt-2 rounded-[var(--radius-sm)] bg-[var(--warn-bg)] p-2 text-xs text-[var(--warn-fg)]">
                        Concession: {insp.bypassReason}
                      </p>
                    )}

                    {insp.readings.length > 0 && (
                      <div className="scroll-x mt-2">
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th>Dimension</th>
                              <th>Nominal</th>
                              <th>Tolerance</th>
                              <th>Actual</th>
                              <th>Result</th>
                            </tr>
                          </thead>
                          <tbody>
                            {insp.readings.map((r, i) => (
                              <tr key={`${r.key}-${i}`}>
                                <td>
                                  {r.name}
                                  {r.adHoc && (
                                    <span className="ms-1 text-xs text-[var(--muted)]">
                                      (added on the sheet)
                                    </span>
                                  )}
                                </td>
                                <td className="num">{fmtNum(r.nominal)}</td>
                                <td className="num">
                                  {r.tolMinus == null && r.tolPlus == null
                                    ? "—"
                                    : `−${fmtNum(r.tolMinus ?? 0)} / +${fmtNum(r.tolPlus ?? 0)}`}
                                </td>
                                <td className="num font-bold">{fmtNum(r.actual)}</td>
                                <td><StatusPill status={r.result} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {insp.defects.length > 0 && (
                      <ul className="mt-2 grid gap-0.5 text-xs">
                        {insp.defects.map((f, i) => (
                          <li key={`${f.key}-${i}`}>
                            • <strong>{f.name}</strong>
                            {f.department ? ` — ${f.department}` : ""}
                            {f.note ? ` · ${f.note}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}

                    <PhotoGallery inspectionId={insp.id} />
                  </div>
                ))}
              </div>
            )}
          </Card>

          {d.reworkHistory.length > 0 && (
            <Card className="mt-4" title="Rework history">
              <div className="scroll-x">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th>Department</th>
                      <th>Held</th>
                      <th>Closed</th>
                      <th>How long</th>
                      <th>Recorded by</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.reworkHistory.map((r) => (
                      <tr key={r.id}>
                        <td>{STAGE_LABELS[r.stage]}</td>
                        <td>{r.department}</td>
                        <td className="num whitespace-nowrap">{fmtDateTime(r.heldAt)}</td>
                        <td className="num whitespace-nowrap">
                          {r.completedAt ? fmtDateTime(r.completedAt) : "still open"}
                        </td>
                        <td className="num">
                          {r.completedAt
                            ? fmtDuration(r.completedAt.getTime() - r.heldAt.getTime())
                            : "—"}
                        </td>
                        <td>{r.recordedByName ?? "—"}</td>
                        <td>{r.note ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <p className="no-print mt-4 text-sm">
            <Link href={`/queue/?stage=${d.piece.stage}`} className="font-bold text-[var(--brand)]">
              ← Back to the {STAGE_LABELS[d.piece.stage]} queue
            </Link>
          </p>
        </>
      )}
    </Async>
  );
}

function PiecePicker() {
  const id = useSearchParams().get("id");
  if (!id) return <Empty>No piece was named.</Empty>;
  return <PieceView id={id} />;
}

export default function PiecePage() {
  return (
    <Suspense fallback={null}>
      <PiecePicker />
    </Suspense>
  );
}
