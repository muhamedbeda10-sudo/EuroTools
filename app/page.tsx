"use client";

import Link from "next/link";

import { Card, Empty, PageHeader, Stat, StatusPill } from "@/components/ui";
import { getDashboard } from "@/lib/client/queries";
import { stageDef } from "@/lib/domain/stages";
import { fmtDateTime, pct } from "@/lib/format";
import { Async } from "@/components/Async";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession } from "@/lib/client/session";

export default function DashboardPage() {
  const user = useRequireSession();
  const state = useAsync(() => getDashboard(), []);

  if (!user) return null;
  return <Async state={state}>{(data) => <DashboardView {...data} />}</Async>;
}

function DashboardView({
  lotCounts,
  partCounts,
  queues,
  blocked,
  inspections,
  firstPassYield,
}: Awaited<ReturnType<typeof getDashboard>>) {

  return (
    <>
      <PageHeader
        title="Quality Dashboard"
        subtitle="From goods-in to final release"
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Lots awaiting inspection"
          value={lotCounts.pending}
          hint={`${lotCounts.total} lots recorded`}
          tone={lotCounts.pending > 0 ? "warn" : "ok"}
          href="/lots"
        />
        <Stat
          label="Parts in process"
          value={partCounts.inProcess}
          hint={`${partCounts.rework} in rework · ${partCounts.hold} on hold`}
          tone="info"
          href="/parts"
        />
        <Stat
          label="Released"
          value={partCounts.released}
          hint={`${partCounts.rejected} rejected`}
          tone="ok"
          href="/parts?status=RELEASED"
        />
        <Stat
          label="First-pass yield"
          value={firstPassYield == null ? "—" : pct(firstPassYield, 1)}
          hint="released ÷ (released + rejected)"
          tone={firstPassYield != null && firstPassYield < 0.9 ? "warn" : "ok"}
          href="/reports"
        />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card
          title="Inspection queues"
          subtitle="Parts waiting at each stage"
          className="lg:col-span-2"
          action={
            <Link href="/queue" className="btn">
              Open the queues
            </Link>
          }
        >
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {queues.map((q) => {
              const def = stageDef(q.stage);
              return (
                <Link
                  key={q.stage}
                  href={`/queue#${q.stage}`}
                  className="rounded-[var(--radius-sm)] border border-[var(--border)] p-3 transition hover:border-[var(--brand)]"
                >
                  <div className="text-xs font-semibold text-[var(--muted)]">
                    {def.order}. {def.en}
                  </div>
                  <div className="num mt-1 text-2xl font-bold">{q.waiting}</div>
                  {q.onHold > 0 && (
                    <div className="mt-1 text-xs font-semibold text-[var(--warn-fg)]">
                      {q.onHold} on hold
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </Card>

        <Card title="Materials needing attention" subtitle="Missing certificates or an unfinished analysis">
          {blocked.length === 0 ? (
            <Empty>Nothing outstanding on any material.</Empty>
          ) : (
            <ul className="grid gap-2">
              {blocked.slice(0, 8).map((b) => (
                <li key={b.lot.id}>
                  <Link
                    href={`/lots/view?id=${b.lot.id}`}
                    className="block rounded-[var(--radius-sm)] border border-[var(--border)] p-2.5 transition hover:border-[var(--brand)]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="ltr text-sm font-bold">{b.lot.lotNumber}</span>
                      <StatusPill status={b.lot.status} />
                    </div>
                    <ul className="mt-1 grid gap-0.5 text-xs text-[var(--muted)]">
                      {b.missingCerts.length > 0 && (
                        <li>Missing certificates: <span className="ltr">{b.missingCerts.join(", ")}</span></li>
                      )}
                      {b.analysisRejected && <li>Analysis rejected</li>}
                      {b.analysisPending && !b.analysisRejected && <li>Analysis in progress</li>}
                    </ul>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-4" title="Latest inspections">
        {inspections.length === 0 ? (
          <Empty>No inspection has been recorded yet.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Part / Lot</th>
                  <th>Inspector</th>
                  <th>Verdict</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {inspections.map((i) => (
                  <tr key={i.id}>
                    <td>{stageDef(i.stage).en}</td>
                    <td className="ltr font-semibold">
                      {i.part?.serialNumber ?? i.lot?.lotNumber ?? "—"}
                    </td>
                    <td>{i.inspector}</td>
                    <td>
                      <StatusPill status={i.status} />
                    </td>
                    <td className="num text-xs text-[var(--muted)]">
                      {fmtDateTime(i.inspectedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
