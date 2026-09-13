"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";

import { Async } from "@/components/Async";
import { InlineForm } from "@/components/InlineForm";
import { Card, Empty, StatusPill } from "@/components/ui";
import { FilterBar } from "@/components/FilterBar";
import { PrintButton } from "@/components/PrintButton";
import { PrintHeader } from "@/components/PrintHeader";
import { ChevronIcon } from "@/components/icons";
import { STAGES, STAGE_LABELS, isStage, type Stage } from "@/lib/domain/workflow";
import { allows } from "@/lib/domain/roles";
import { facetValues, matchesFacet, matchesText } from "@/lib/filter";
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

      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <nav className="nav-tabs">
          {STAGES.map((s) => (
            <Link
              key={s}
              href={`/queue/?stage=${s}`}
              className={`nav-tab ${s === stage ? "nav-tab-on" : ""}`}
            >
              {STAGE_LABELS[s]}
            </Link>
          ))}
        </nav>
        <PrintButton label="Print" />
      </div>

      <Async state={state}>
        {(q) => <Lists q={q} stage={stage} me={me} refresh={state.refresh} />}
      </Async>
    </>
  );
}

/** Both lists, and the one bar that narrows them.
 *
 *  A component of its own rather than the body of the render prop, because it
 *  holds the filter state and hooks may not live inside a callback that only
 *  runs once the data has arrived.
 */
function Lists({
  q,
  stage,
  me,
  refresh,
}: {
  q: Awaited<ReturnType<typeof getQueue>>;
  stage: Stage;
  me: SessionUser;
  refresh: () => void;
}) {
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState("");
  const [measuring, setMeasuring] = useState("");

  const all = useMemo(
    () => [...q.byLine.toMeasure, ...q.byLine.inRework],
    [q.byLine.toMeasure, q.byLine.inRework]
  );

  /** A group survives if the line matches, or if any piece under it does — so
   *  a serial typed in full finds the line holding it rather than nothing. */
  const keep = useMemo(() => {
    return (group: QueueGroup) =>
      matchesFacet(group.priority, priority) &&
      matchesFacet(group.measuringType, measuring) &&
      (matchesText([group.project, group.itemCode, group.itemName], query) ||
        group.pieces.some((p) => matchesText([p.serial], query)));
  }, [query, priority, measuring]);

  const toMeasure = q.byLine.toMeasure.filter(keep);
  const inRework = q.byLine.inRework.filter(keep);

  const count = (groups: QueueGroup[]) => groups.reduce((n, g) => n + g.pieces.length, 0);
  const showing = count(toMeasure) + count(inRework);

  return (
    <div className="print-wide">
      <PrintHeader
        title={`${STAGE_LABELS[stage]} — what quality is holding`}
        subtitle={`${count(toMeasure)} waiting to be measured · ${count(inRework)} in rework`}
        by={me.displayName}
      />

      <FilterBar
        query={query}
        onQuery={setQuery}
        placeholder="Search a project, an item or a serial…"
        noun="piece"
        showing={showing}
        total={q.toMeasure.length + q.inRework.length}
        facets={[
          {
            key: "priority",
            label: "Priority",
            options: facetValues(all, (g) => g.priority),
            value: priority,
            onChange: setPriority,
          },
          {
            key: "measuring",
            label: "Measuring",
            options: facetValues(all, (g) => g.measuringType),
            value: measuring,
            onChange: setMeasuring,
          },
        ]}
      />

      <Card
        title="Waiting on quality"
        action={<span className="pill pill-info">{count(toMeasure)}</span>}
      >
        {toMeasure.length === 0 ? (
          <Empty>
            {q.toMeasure.length === 0
              ? "Nothing to measure at this stage."
              : "Nothing here matches the filter."}
          </Empty>
        ) : (
          <Groups groups={toMeasure} action="measure" me={me} refresh={refresh} />
        )}
      </Card>

      <Card
        className="mt-4"
        title="In rework"
        subtitle="With a department. Close it out when they report back."
        action={<span className="pill pill-warn">{count(inRework)}</span>}
      >
        {inRework.length === 0 ? (
          <Empty>
            {q.inRework.length === 0
              ? "Nothing is with a department."
              : "Nothing here matches the filter."}
          </Empty>
        ) : (
          <Groups groups={inRework} action="rework" me={me} refresh={refresh} />
        )}
      </Card>
    </div>
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
  // Closed by default. The first thing anybody wants from this screen is how
  // much work is standing and against which lines; the serials matter only
  // once a line has been picked. Open lists of five push the next line off the
  // screen and turn that first question into scrolling.
  const [open, setOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--border)]">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 bg-[var(--surface-2)] px-3 py-2.5 text-start transition-colors hover:bg-[var(--brand-light)]"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronIcon
          className={`no-print h-4 w-4 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
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
          <span
            className={`pill ${action === "rework" ? "pill-warn" : "pill-info"}`}
            title={action === "rework" ? "Pieces in rework" : "Pieces waiting to be measured"}
          >
            <span className="num text-sm font-bold">{group.pieces.length}</span>
            <span className="ms-1">{group.pieces.length === 1 ? "piece" : "pieces"}</span>
          </span>
          <span className="num text-xs text-[var(--muted)]">
            longest {fmtDuration(group.longestWaitMs)}
          </span>
        </span>
      </button>

      <div className={open ? undefined : "closed-on-screen"}>
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
      </div>
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
