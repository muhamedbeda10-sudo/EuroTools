"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { Async } from "@/components/Async";
import { Card, Empty, Kv, PageHeader, StatusPill } from "@/components/ui";
import { STAGE_LABELS } from "@/lib/domain/workflow";
import { fmtDate, fmtDuration } from "@/lib/format";
import { getLine } from "@/lib/client/queries";
import { lineIsComplete } from "@/lib/model";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession } from "@/lib/client/session";

/** One planning line, and every piece cut from it. */
function LineView({ id }: { id: string }) {
  const me = useRequireSession();
  const state = useAsync(() => getLine(id), [id]);
  if (!me) return null;

  return (
    <Async state={state} empty={<Empty>That line does not exist.</Empty>}>
      {(d) => (
        <>
          <PageHeader
            title={`${d.line.project} · ${d.line.itemCode}`}
            subtitle={d.line.itemName}
          />

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="The line as planning wrote it">
              <Kv k="Project" v={<span className="ltr">{d.line.project}</span>} />
              <Kv k="MPLPR" v={<span className="ltr">{d.line.mplpr ?? "—"}</span>} />
              <Kv k="Item" v={<span className="ltr">{d.line.itemCode}</span>} />
              <Kv k="Quantity" v={<span className="num">{d.line.qty}</span>} />
              <Kv k="Measuring" v={d.line.measuringType === "CMM" ? "CMM" : "Traditional"} />
              <Kv k="Priority" v={<span className="ltr">{d.line.priority ?? "—"}</span>} />
              <Kv k="Planned" v={<span className="num">{fmtDate(d.line.plannedAt)}</span>} />
              <Kv k="Times measured" v={<span className="num">{d.line.counts.measurements}</span>} />
              <Kv
                k="Complete"
                v={
                  lineIsComplete(d.line.counts) ? (
                    <span className="pill pill-ok">Yes</span>
                  ) : (
                    <span className="pill pill-info">{d.line.counts.withQc} still with quality</span>
                  )
                }
              />
            </Card>

            <Card className="lg:col-span-2" title={`Pieces (${d.pieces.length})`}>
              {d.pieces.length === 0 ? (
                <Empty>No pieces.</Empty>
              ) : (
                <div className="scroll-x">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Piece</th>
                        <th>Stage</th>
                        <th>State</th>
                        <th>With</th>
                        <th>Rounds here</th>
                        <th>Times measured</th>
                        <th>With quality</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {d.pieces.map((p) => (
                        <tr key={p.id}>
                          <td className="ltr font-bold">{p.serial}</td>
                          <td>{STAGE_LABELS[p.stage]}</td>
                          <td><StatusPill status={p.state} /></td>
                          <td>{p.holdDepartment ?? "—"}</td>
                          <td className="num">{p.round}</td>
                          <td className="num">{p.measuredTimes}</td>
                          <td className="num whitespace-nowrap">{fmtDuration(p.qcMs)}</td>
                          <td>
                            <Link href={`/piece/?id=${p.id}`} className="font-bold text-[var(--brand)]">
                              Open
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>

          <p className="mt-4 text-sm">
            <Link href="/planning/" className="font-bold text-[var(--brand)]">← All lines</Link>
          </p>
        </>
      )}
    </Async>
  );
}

function LinePicker() {
  const id = useSearchParams().get("id");
  if (!id) return <Empty>No line was named.</Empty>;
  return <LineView id={id} />;
}

export default function LinePage() {
  return (
    <Suspense fallback={null}>
      <LinePicker />
    </Suspense>
  );
}
