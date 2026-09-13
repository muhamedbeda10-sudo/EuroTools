"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Async } from "@/components/Async";
import { FilterBar } from "@/components/FilterBar";
import { Card, Empty, Stat, StatusPill } from "@/components/ui";
import { STAGES, STAGE_LABELS } from "@/lib/domain/workflow";
import { matchesText } from "@/lib/filter";
import { fmtDateTime, fmtDuration, fmtNum } from "@/lib/format";
import { getDashboard } from "@/lib/client/queries";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession } from "@/lib/client/session";

/** What the data can be asked, now that it is all in one shape.
 *
 *  Every number here comes from a count Firestore did or a tally kept beside
 *  the record that caused it. Nothing on this page reads a collection and
 *  counts it, which is what keeps the whole screen inside a handful of reads
 *  however many pieces the plant has been through.
 */
export default function DashboardPage() {
  const me = useRequireSession();
  const state = useAsync(() => getDashboard(), []);
  if (!me) return null;

  return (
    <Async state={state}>
      {(d) => (
        <>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Waiting on quality" value={d.totals.withQc} tone={d.totals.withQc > 0 ? "warn" : "ok"}
              hint={`${d.totals.pieces} pieces on ${d.totals.lines} lines`} />
            <Stat label="In rework" value={d.totals.inRework} tone={d.totals.inRework > 0 ? "warn" : undefined}
              hint="With a department" />
            <Stat label="Closed" value={d.totals.closed} tone="ok" hint="Through both stages" />
            <Stat
              label="First-pass rate"
              value={d.firstPassRate == null ? "—" : `${fmtNum(d.firstPassRate, 1)}%`}
              tone={d.firstPassRate != null && d.firstPassRate < 80 ? "warn" : "ok"}
              hint={d.bypasses > 0 ? `${d.bypasses} on concession` : "accepted ÷ decisions"}
            />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            <Card title="The two stages" subtitle="What is standing where">
              <div className="grid grid-cols-2 gap-3">
                {STAGES.map((stage) => (
                  <Link
                    key={stage}
                    href={`/queue/?stage=${stage}`}
                    className="rounded-[var(--radius-sm)] border border-[var(--border)] p-3 transition hover:border-[var(--brand)]"
                  >
                    <div className="text-sm font-bold">{STAGE_LABELS[stage]}</div>
                    <div className="mt-1 text-2xl font-bold num">{d.stages[stage].waiting}</div>
                    <div className="text-xs text-[var(--muted)]">waiting on quality</div>
                    {d.stages[stage].rework > 0 && (
                      <div className="mt-1 text-xs font-semibold text-[var(--warn-fg)]">
                        {d.stages[stage].rework} in rework
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            </Card>

            <Card title="Holds by department" subtitle="Who the work is going back to">
              {d.holdsByDepartment.length === 0 ? (
                <Empty>Nothing has been held yet.</Empty>
              ) : (
                <ul className="grid gap-1.5 text-sm">
                  {d.holdsByDepartment.slice(0, 8).map((h) => (
                    <li key={h.department} className="flex items-baseline justify-between gap-3">
                      <span>{h.department}</span>
                      <span className="num font-bold">{h.n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Most frequent defects" subtitle="Counted as they were ticked">
              {d.topDefects.length === 0 ? (
                <Empty>No defect has been recorded yet.</Empty>
              ) : (
                <ul className="grid gap-1.5 text-sm">
                  {d.topDefects.map((t) => (
                    <li key={t.key} className="flex items-baseline justify-between gap-3">
                      <span className="capitalize">{t.key.replace(/_/g, " ")}</span>
                      <span className="num font-bold">{t.n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Waiting rows={d.oldestWaiting} />
          <Decisions rows={d.recentInspections} />
        </>
      )}
    </Async>
  );
}

type Dashboard = Awaited<ReturnType<typeof getDashboard>>;

/** The two tables carry a search of their own rather than sharing one with the
 *  page.
 *
 *  The tallies above them are counters kept beside the records that moved
 *  them, not sums over these rows — so a filter cannot honestly change them. A
 *  search that sat at the top of the page would look like it had, which is
 *  worse than not having one.
 */
function Waiting({ rows }: { rows: Dashboard["oldestWaiting"] }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(
    () =>
      rows.filter((p) => matchesText([p.serial, p.project, p.itemName, p.priority], query)),
    [rows, query]
  );

  return (
    <Card
      className="mt-4"
      title="Waiting longest"
      subtitle="The ones somebody is asking about"
    >
      {rows.length === 0 ? (
        <Empty>Nothing is waiting on quality.</Empty>
      ) : (
        <>
          <FilterBar
            query={query}
            onQuery={setQuery}
            placeholder="Search this list…"
            noun="piece"
            showing={shown.length}
            total={rows.length}
          />
          {shown.length === 0 ? (
            <Empty>Nothing here matches the filter.</Empty>
          ) : (
            <div className="scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Piece</th>
                    <th>Project</th>
                    <th>Item</th>
                    <th>Stage</th>
                    <th>Priority</th>
                    <th>With quality</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((p) => (
                    <tr key={p.id}>
                      <td className="ltr font-bold">{p.serial}</td>
                      <td className="ltr">{p.project}</td>
                      <td>{p.itemName}</td>
                      <td><StatusPill status={p.stage} /></td>
                      <td className="ltr">{p.priority ?? "—"}</td>
                      <td className="num">{fmtDuration(p.qcMs)}</td>
                      <td>
                        <Link href={`/piece/?id=${p.id}`} className="font-bold text-[var(--brand)]">
                          Measure
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function Decisions({ rows }: { rows: Dashboard["recentInspections"] }) {
  const [query, setQuery] = useState("");
  const shown = useMemo(
    () =>
      rows.filter((i) =>
        matchesText([i.serial, i.inspector, i.verdict, i.holdDepartment], query)
      ),
    [rows, query]
  );

  return (
    <Card className="mt-4" title="Latest decisions">
      {rows.length === 0 ? (
        <Empty>No inspection has been recorded yet.</Empty>
      ) : (
        <>
          <FilterBar
            query={query}
            onQuery={setQuery}
            placeholder="Search this list…"
            noun="decision"
            showing={shown.length}
            total={rows.length}
          />
          {shown.length === 0 ? (
            <Empty>Nothing here matches the filter.</Empty>
          ) : (
            <div className="scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Piece</th>
                    <th>Stage</th>
                    <th>Round</th>
                    <th>Inspector</th>
                    <th>Verdict</th>
                    <th>Held against</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((i) => (
                    <tr key={i.id}>
                      <td className="ltr font-bold">{i.serial}</td>
                      <td>{STAGE_LABELS[i.stage]}</td>
                      <td className="num">{i.round}</td>
                      <td>{i.inspector}</td>
                      <td><StatusPill status={i.verdict} /></td>
                      <td>{i.holdDepartment ?? "—"}</td>
                      <td className="num">{fmtDateTime(i.inspectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
