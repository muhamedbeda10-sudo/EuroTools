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
        title="لوحة متابعة الجودة"
        subtitle="من استلام الخامة حتى الإفراج النهائي"
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="تشغيلات خامات بانتظار الفحص"
          value={lotCounts.pending}
          hint={`${lotCounts.total} تشغيلة مسجلة`}
          tone={lotCounts.pending > 0 ? "warn" : "ok"}
          href="/lots"
        />
        <Stat
          label="أجزاء قيد التشغيل"
          value={partCounts.inProcess}
          hint={`${partCounts.rework} إعادة تشغيل · ${partCounts.hold} موقوف`}
          tone="info"
          href="/parts"
        />
        <Stat
          label="تم الإفراج عنه"
          value={partCounts.released}
          hint={`${partCounts.rejected} مرفوض`}
          tone="ok"
          href="/parts?status=RELEASED"
        />
        <Stat
          label="نسبة القبول النهائي"
          value={firstPassYield == null ? "—" : pct(firstPassYield, 1)}
          hint="مُفرج عنه ÷ (مُفرج عنه + مرفوض)"
          tone={firstPassYield != null && firstPassYield < 0.9 ? "warn" : "ok"}
          href="/reports"
        />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card
          title="طوابير الفحص"
          subtitle="الأجزاء الواقفة عند كل مرحلة"
          className="lg:col-span-2"
          action={
            <Link href="/queue" className="btn">
              فتح الطوابير
            </Link>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {queues.map((q) => {
              const def = stageDef(q.stage);
              return (
                <Link
                  key={q.stage}
                  href={`/queue#${q.stage}`}
                  className="rounded-[var(--radius-sm)] border border-[var(--border)] p-3 transition hover:border-[var(--brand)]"
                >
                  <div className="text-xs font-semibold text-[var(--muted)]">
                    {def.order}. {def.ar}
                  </div>
                  <div className="num mt-1 text-2xl font-bold">{q.waiting}</div>
                  {q.onHold > 0 && (
                    <div className="mt-1 text-xs font-semibold text-[var(--warn-fg)]">
                      {q.onHold} موقوف
                    </div>
                  )}
                </Link>
              );
            })}
          </div>
        </Card>

        <Card title="خامات تحتاج متابعة" subtitle="شهادات ناقصة أو تحليل غير مكتمل">
          {blocked.length === 0 ? (
            <Empty>لا توجد ملاحظات على الخامات.</Empty>
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
                        <li>شهادات ناقصة: <span className="ltr">{b.missingCerts.join("، ")}</span></li>
                      )}
                      {b.analysisRejected && <li>تحليل مرفوض</li>}
                      {b.analysisPending && !b.analysisRejected && <li>تحليل قيد التنفيذ</li>}
                    </ul>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card className="mt-4" title="آخر عمليات الفحص">
        {inspections.length === 0 ? (
          <Empty>لم يُسجَّل أي فحص بعد.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>المرحلة</th>
                  <th>الجزء / التشغيلة</th>
                  <th>الفاحص</th>
                  <th>الحالة</th>
                  <th>التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {inspections.map((i) => (
                  <tr key={i.id}>
                    <td>{stageDef(i.stage).ar}</td>
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
