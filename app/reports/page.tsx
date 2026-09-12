"use client";

import Link from "next/link";

import { PrintButton } from "@/components/PrintButton";
import { Card, Empty, PageHeader, Stat, StatusPill } from "@/components/ui";
import { getQualityReport } from "@/lib/client/queries";
import { deviation } from "@/lib/domain/inspection";
import { stageDef } from "@/lib/domain/stages";
import { fmtDate, fmtNum, fmtTolerance, pct } from "@/lib/format";
import { Async } from "@/components/Async";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession } from "@/lib/client/session";
import { ExportCsvButton } from "@/components/ExportCsvButton";
import { VerdictReconciliation } from "@/components/VerdictReconciliation";

export default function ReportsPage() {
  const user = useRequireSession();
  const state = useAsync(() => getQualityReport(), []);

  if (!user) return null;
  return <Async state={state}>{(data) => <ReportsView {...data} />}</Async>;
}

function ReportsView({
  byStage,
  topFailures,
  outOfTolerance,
  released,
  total,
}: Awaited<ReturnType<typeof getQualityReport>>) {

  const totals = byStage.reduce(
    (acc, s) => ({
      passed: acc.passed + s.passed,
      rework: acc.rework + s.rework,
      rejected: acc.rejected + s.rejected,
      investigation: acc.investigation + s.investigation,
    }),
    { passed: 0, rework: 0, rejected: 0, investigation: 0 }
  );

  return (
    <>
      <PageHeader
        title="Quality Reports"
        subtitle={`${total} inspections recorded`}
        action={
          <div className="flex gap-2">
            <ExportCsvButton />
            <PrintButton />
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Accepted" value={totals.passed} tone="ok" />
        <Stat label="Rework" value={totals.rework} tone="warn" />
        <Stat label="Further investigation" value={totals.investigation} tone="warn" />
        <Stat label="Rejected" value={totals.rejected} tone="bad" />
      </div>

      <Card className="mt-4" title="Performance by stage">
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>Stage</th>
                <th>Inspections</th>
                <th>Accepted</th>
                <th>Rework</th>
                <th>Further investigation</th>
                <th>Rejected</th>
                <th>Pending</th>
                <th>Pass rate</th>
              </tr>
            </thead>
            <tbody>
              {byStage.map((s) => (
                <tr key={s.def.stage}>
                  <td>
                    <span className="font-semibold">
                      {s.def.order}. {s.def.en}
                    </span>
                    <div className="ltr text-xs text-[var(--muted)]">{s.def.en}</div>
                  </td>
                  <td className="num">{s.total}</td>
                  <td className="num text-[var(--ok-fg)]">{s.passed}</td>
                  <td className="num text-[var(--warn-fg)]">{s.rework}</td>
                  <td className="num text-[var(--warn-fg)]">{s.investigation}</td>
                  <td className="num text-[var(--bad-fg)]">{s.rejected}</td>
                  <td className="num text-[var(--muted)]">{s.pending}</td>
                  <td className="num font-bold">
                    {s.passRate == null ? "—" : pct(s.passRate, 1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card
          title="Most frequent non-conformances"
          subtitle="Counted from the checklist answers themselves, not only from the final verdict"
        >
          {topFailures.length === 0 ? (
            <Empty>No failed checklist items recorded.</Empty>
          ) : (
            <div className="scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Stage</th>
                    <th>Item</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  {topFailures.slice(0, 12).map((f) => {
                    const def = stageDef(f.stage);
                    const item = def.items.find((i) => i.key === f.key);
                    return (
                      <tr key={`${f.stage}-${f.key}`}>
                        <td className="text-xs">{def.en}</td>
                        <td>{item?.en ?? f.key}</td>
                        <td className="num font-bold">{f.count}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Measurements outside tolerance" subtitle="The 50 most recent">
          {outOfTolerance.length === 0 ? (
            <Empty>No measurement is outside tolerance.</Empty>
          ) : (
            <div className="scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Part</th>
                    <th>Stage</th>
                    <th>Feature</th>
                    <th>Required</th>
                    <th>Measured</th>
                    <th>Deviation</th>
                  </tr>
                </thead>
                <tbody>
                  {outOfTolerance.map((o, oi) => (
                    <tr key={`${o.subject}-${o.measurement.featureId ?? "m"}-${oi}`}>
                      <td className="ltr text-xs font-semibold">{o.subject}</td>
                      <td className="text-xs">{stageDef(o.stage).en}</td>
                      <td>
                        {o.measurement.name}
                        {o.measurement.critical && (
                          <span className="pill pill-bad ms-1">C</span>
                        )}
                      </td>
                      <td className="num">
                        {o.measurement.kind === "GDT"
                          ? `≤ ${fmtNum(o.measurement.gdtLimit)}`
                          : fmtTolerance(
                              o.measurement.nominal,
                              o.measurement.tolMinus,
                              o.measurement.tolPlus
                            )}
                      </td>
                      <td className="num">{fmtNum(o.measurement.actual)}</td>
                      <td className="num font-bold text-[var(--bad-fg)]">
                        {fmtNum(deviation(o.measurement))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card
        className="mt-4 page-break"
        title="Final quality release"
        subtitle="Final Quality Release"
        action={<span className="pill pill-ok">{released.length} parts</span>}
      >
        {released.length === 0 ? (
          <Empty>No part has been released yet.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Serial number</th>
                  <th>Part number</th>
                  <th>Lot</th>
                  <th>Released</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {released.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link href={`/parts/view?id=${p.id}`} className="ltr font-bold text-[var(--brand)]">
                        {p.serialNumber}
                      </Link>
                    </td>
                    <td className="ltr">{p.material.partNumber}</td>
                    <td className="ltr text-xs">{p.lot?.lotNumber ?? "—"}</td>
                    <td className="num text-xs">{fmtDate(p.updatedAt)}</td>
                    <td>
                      <StatusPill status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <VerdictReconciliation />
    </>
  );
}
