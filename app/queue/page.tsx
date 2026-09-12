"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { Async } from "@/components/Async";
import { InlineForm } from "@/components/InlineForm";
import { Card, Empty, PageHeader, StatusPill } from "@/components/ui";
import { STAGES, STAGE_LABELS, isStage, type Stage } from "@/lib/domain/workflow";
import { can } from "@/lib/domain/roles";
import { fmtDate, fmtDuration } from "@/lib/format";
import { recordReworkDone } from "@/lib/client/actions";
import { getQueue, type QueueRow } from "@/lib/client/queries";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession, type SessionUser } from "@/lib/client/session";

/** One stage's queue: what quality has to measure, and what a department still
 *  owes back. Both on one screen because the second is the reason the first is
 *  shorter than it should be, and hiding it makes the backlog somebody else's
 *  problem by omission. */
function QueueView({ stage }: { stage: Stage }) {
  const me = useRequireSession();
  const state = useAsync(() => getQueue(stage), [stage]);
  if (!me) return null;

  return (
    <>
      <PageHeader
        title={`${STAGE_LABELS[stage]} queue`}
        subtitle="Highest priority first, then whatever has waited longest"
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {STAGES.map((s) => (
          <Link
            key={s}
            href={`/queue/?stage=${s}`}
            className={`btn ${s === stage ? "btn-primary" : ""}`}
          >
            {STAGE_LABELS[s]}
          </Link>
        ))}
      </div>

      <Async state={state}>
        {(q) => (
          <>
            <Card
              title="Waiting on quality"
              action={<span className="pill pill-info">{q.toMeasure.length}</span>}
            >
              {q.toMeasure.length === 0 ? (
                <Empty>Nothing to measure at this stage.</Empty>
              ) : (
                <Rows rows={q.toMeasure} action="measure" me={me} refresh={state.refresh} />
              )}
            </Card>

            <Card
              className="mt-4"
              title="In rework"
              subtitle="Held by quality, with a department. Close it out when they report back."
              action={<span className="pill pill-warn">{q.inRework.length}</span>}
            >
              {q.inRework.length === 0 ? (
                <Empty>Nothing is with a department.</Empty>
              ) : (
                <Rows rows={q.inRework} action="rework" me={me} refresh={state.refresh} />
              )}
            </Card>
          </>
        )}
      </Async>
    </>
  );
}

function Rows({
  rows,
  action,
  me,
  refresh,
}: {
  rows: QueueRow[];
  action: "measure" | "rework";
  me: SessionUser;
  refresh: () => void;
}) {
  return (
    <div className="scroll-x">
      <table className="tbl">
        <thead>
          <tr>
            <th>Piece</th>
            <th>Project</th>
            <th>Item</th>
            <th>Priority</th>
            <th>Measuring</th>
            <th>Planned</th>
            {action === "rework" ? <th>With</th> : <th>Round</th>}
            <th>With quality</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td className="ltr font-bold whitespace-nowrap">
                <Link href={`/piece/?id=${p.id}`} className="text-[var(--brand)]">
                  {p.serial}
                </Link>
              </td>
              <td className="ltr">{p.project}</td>
              <td>{p.itemName}</td>
              <td className="ltr">{p.priority ?? "—"}</td>
              <td>{p.measuringType === "CMM" ? "CMM" : "Traditional"}</td>
              <td className="num whitespace-nowrap">{fmtDate(p.plannedAt)}</td>
              {action === "rework" ? (
                <td>{p.holdDepartment ?? "—"}</td>
              ) : (
                <td className="num">{p.round > 0 ? `#${p.round + 1}` : "first"}</td>
              )}
              <td className="num whitespace-nowrap">{fmtDuration(p.qcMs)}</td>
              <td className="whitespace-nowrap">
                {action === "measure" ? (
                  <Link href={`/piece/?id=${p.id}`} className="btn btn-primary">
                    Measure
                  </Link>
                ) : can(me.role, "rework.record") ? (
                  <InlineForm
                    action={recordReworkDone(me)}
                    onSuccess={refresh}
                    submitLabel="Rework done"
                    submitClassName=""
                    confirm={`${p.holdDepartment} has finished the rework on ${p.serial}?`}
                  >
                    <input type="hidden" name="pieceId" value={p.id} />
                  </InlineForm>
                ) : (
                  <StatusPill status={p.state} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueuePicker() {
  const stage = useSearchParams().get("stage");
  return <QueueView stage={isStage(stage) ? stage : STAGES[0]} />;
}

export default function QueuePage() {
  return (
    <Suspense fallback={null}>
      <QueuePicker />
    </Suspense>
  );
}
