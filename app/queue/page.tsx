"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Async } from "@/components/Async";
import { InlineForm } from "@/components/InlineForm";
import { Card, Empty, StatusPill } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";
import { STAGES, STAGE_LABELS, isStage, type Stage } from "@/lib/domain/workflow";
import { allows } from "@/lib/domain/roles";
import { fmtDate, fmtDuration } from "@/lib/format";
import { recordReworkDone } from "@/lib/client/actions";
import { getQueue, type QueueGroup } from "@/lib/client/queries";
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
                <Groups groups={q.byLine.toMeasure} action="measure" me={me} refresh={state.refresh} />
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
                <Groups groups={q.byLine.inRework} action="rework" me={me} refresh={state.refresh} />
              )}
            </Card>
          </>
        )}
      </Async>
    </>
  );
}

/** The queue, grouped by the line each piece came from.
 *
 *  Five pieces of one part used to be five rows saying the same thing five
 *  times. They now stand under one heading that carries what they share — the
 *  project, the item, the priority — so the only thing repeated underneath is
 *  what actually differs.
 */
function Groups({
  groups,
  action,
  me,
  refresh,
}: {
  groups: QueueGroup[];
  action: "measure" | "rework";
  me: SessionUser;
  refresh: () => void;
}) {
  return (
    <div className="grid gap-2">
      {groups.map((group) => (
        <Group key={group.lineId} group={group} action={action} me={me} refresh={refresh} />
      ))}
    </div>
  );
}

function Group({
  group,
  action,
  me,
  refresh,
}: {
  group: QueueGroup;
  action: "measure" | "rework";
  me: SessionUser;
  refresh: () => void;
}) {
  // Open by default: somebody working the queue measures these one after the
  // other, and a list that has to be opened first is a click before every
  // piece. Collapsing is for scanning, which is the rarer job.
  const [open, setOpen] = useState(true);

  return (
    <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)]">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 bg-[var(--surface-2)] px-3 py-2.5 text-start transition-colors hover:bg-[var(--brand-light)]"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronIcon
          className={`h-4 w-4 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
        />

        <span className="ltr font-bold">{group.project}</span>
        <span className="text-[var(--muted)]">·</span>
        <span className="ltr font-semibold">{group.itemCode}</span>
        <span className="text-sm text-[var(--muted)]">{group.itemName}</span>

        <span className="ms-auto flex flex-wrap items-center gap-2">
          {group.priority && <span className="pill pill-neutral ltr">{group.priority}</span>}
          <span className="pill pill-neutral">
            {group.measuringType === "CMM" ? "CMM" : "Traditional"}
          </span>
          <span className={`pill ${action === "rework" ? "pill-warn" : "pill-info"}`}>
            {group.pieces.length} {group.pieces.length === 1 ? "piece" : "pieces"}
          </span>
          <span className="num text-xs text-[var(--muted)]">
            longest {fmtDuration(group.longestWaitMs)}
          </span>
        </span>
      </button>

      {open && (
        <div className="scroll-x">
          <table className="tbl">
            <tbody>
              {group.pieces.map((p) => (
                <tr key={p.id}>
                  {/* The rule down the left is what makes this read as a
                      branch of the heading above rather than a table that
                      happens to follow it. */}
                  <td className="w-1 p-0">
                    <span className="ms-3 block h-full w-px bg-[var(--border-strong)]" />
                  </td>

                  <td className="ltr font-bold whitespace-nowrap">
                    <Link href={`/piece/?id=${p.id}`} className="text-[var(--brand)]">
                      {p.serial}
                    </Link>
                  </td>

                  <td className="num text-xs text-[var(--muted)]">#{p.pieceNo}</td>

                  {action === "rework" ? (
                    <td className="text-sm">with {p.holdDepartment ?? "—"}</td>
                  ) : (
                    <td className="text-sm text-[var(--muted)]">
                      {p.round > 0 ? `round ${p.round + 1}` : "first time"}
                    </td>
                  )}

                  <td className="num whitespace-nowrap text-sm">{fmtDuration(p.qcMs)}</td>
                  <td className="whitespace-nowrap text-xs text-[var(--muted)]">
                    planned {fmtDate(p.plannedAt)}
                  </td>

                  <td className="whitespace-nowrap text-end">
                    {action === "measure" ? (
                      <Link href={`/piece/?id=${p.id}`} className="btn btn-primary">
                        Measure
                      </Link>
                    ) : allows(me, "rework.record") ? (
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
      )}
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
