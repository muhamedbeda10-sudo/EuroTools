"use client";

import Link from "next/link";

import { Async } from "@/components/Async";
import { ImportPanel } from "@/components/ImportPanel";
import { InlineForm } from "@/components/InlineForm";
import { Card, Empty, PageHeader } from "@/components/ui";
import { can } from "@/lib/domain/roles";
import { fmtDate } from "@/lib/format";
import { PLANNING_COLUMNS, parsePlanning, type PlanningRow } from "@/lib/import/parse";
import { cancelPlanningLine, importPlanning } from "@/lib/client/actions";
import { getPlanningLines } from "@/lib/client/queries";
import { lineIsComplete } from "@/lib/model";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession } from "@/lib/client/session";

/** Planning's sheet, as quality receives it.
 *
 *  A line here is a row they wrote; the pieces are made from its quantity, and
 *  they are what actually moves. `Complete` is not a column anybody fills in:
 *  a line is complete when no piece on it is waiting to be measured, which is
 *  what planning means by the word.
 */
export default function PlanningPage() {
  const me = useRequireSession();
  const state = useAsync(() => getPlanningLines(), []);
  if (!me) return null;

  const mayManage = can(me.role, "planning.manage");

  return (
    <>
      <PageHeader title="Planning" subtitle="The lines quality has been handed, and where each stands" />

      {mayManage && (
        <Card title="Bring in a sheet" className="mb-4">
          <ImportPanel<PlanningRow>
            title="Each row becomes a line, and its quantity becomes that many pieces."
            columns={PLANNING_COLUMNS}
            parse={parsePlanning}
            commit={(rows) => importPlanning(me)(rows)}
            onDone={state.refresh}
            describe={(r) => `${r.project} · ${r.itemCode} · ${r.qty} pcs · ${r.measuringType}`}
          />
        </Card>
      )}

      <Async state={state}>
        {(lines) => (
          <Card action={<span className="pill pill-neutral">{lines.length}</span>}>
            {lines.length === 0 ? (
              <Empty>No lines yet. Bring in a sheet to start.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>MPLPR</th>
                      <th>Item</th>
                      <th>Name</th>
                      <th>Qty</th>
                      <th>Measuring</th>
                      <th>Priority</th>
                      <th>Planned</th>
                      <th>With quality</th>
                      <th>In rework</th>
                      <th>Closed</th>
                      <th>Times measured</th>
                      <th>Complete</th>
                      {mayManage && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.id}>
                        <td className="ltr font-bold">
                          <Link href={`/planning/line/?id=${l.id}`} className="text-[var(--brand)]">
                            {l.project}
                          </Link>
                        </td>
                        <td className="ltr">{l.mplpr ?? "—"}</td>
                        <td className="ltr">{l.itemCode}</td>
                        <td>{l.itemName}</td>
                        <td className="num">{l.qty}</td>
                        <td>{l.measuringType === "CMM" ? "CMM" : "Traditional"}</td>
                        <td className="ltr">{l.priority ?? "—"}</td>
                        <td className="num whitespace-nowrap">{fmtDate(l.plannedAt)}</td>
                        <td className="num">{l.counts.withQc}</td>
                        <td className="num">{l.counts.inRework}</td>
                        <td className="num">{l.counts.closed}</td>
                        <td className="num">{l.counts.measurements}</td>
                        <td>
                          {lineIsComplete(l.counts) ? (
                            <span className="pill pill-ok">Complete</span>
                          ) : (
                            <span className="pill pill-info">With quality</span>
                          )}
                        </td>
                        {mayManage && (
                          <td>
                            {l.counts.withQc === l.counts.total ? (
                              <InlineForm
                                action={cancelPlanningLine(me)}
                                onSuccess={state.refresh}
                                submitLabel="Cancel"
                                submitClassName="btn-danger"
                                confirm={`Cancel ${l.project} ${l.itemCode} and its ${l.qty} piece(s)? Nothing has been measured yet.`}
                              >
                                <input type="hidden" name="lineId" value={l.id} />
                              </InlineForm>
                            ) : (
                              <span className="text-xs text-[var(--muted)]">started</span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </Async>
    </>
  );
}
