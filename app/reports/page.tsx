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
        title="تقارير الجودة"
        subtitle={`${total} عملية فحص مسجلة`}
        action={
          <div className="flex gap-2">
            <ExportCsvButton />
            <PrintButton />
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="فحوص مقبولة" value={totals.passed} tone="ok" />
        <Stat label="إعادة تشغيل" value={totals.rework} tone="warn" />
        <Stat label="فحص إضافي" value={totals.investigation} tone="warn" />
        <Stat label="مرفوض" value={totals.rejected} tone="bad" />
      </div>

      <Card className="mt-4" title="أداء كل مرحلة">
        <div className="scroll-x">
          <table className="tbl">
            <thead>
              <tr>
                <th>المرحلة</th>
                <th>إجمالي الفحوص</th>
                <th>مقبول</th>
                <th>إعادة تشغيل</th>
                <th>فحص إضافي</th>
                <th>مرفوض</th>
                <th>قيد الانتظار</th>
                <th>نسبة القبول</th>
              </tr>
            </thead>
            <tbody>
              {byStage.map((s) => (
                <tr key={s.def.stage}>
                  <td>
                    <span className="font-semibold">
                      {s.def.order}. {s.def.ar}
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
          title="أكثر البنود تكرارًا في عدم المطابقة"
          subtitle="من واقع إجابات الكشوف — لا من الحالة النهائية فقط"
        >
          {topFailures.length === 0 ? (
            <Empty>لا توجد بنود غير مطابقة مسجلة.</Empty>
          ) : (
            <div className="scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>المرحلة</th>
                    <th>البند</th>
                    <th>التكرار</th>
                  </tr>
                </thead>
                <tbody>
                  {topFailures.slice(0, 12).map((f) => {
                    const def = stageDef(f.stage);
                    const item = def.items.find((i) => i.key === f.key);
                    return (
                      <tr key={`${f.stage}-${f.key}`}>
                        <td className="text-xs">{def.ar}</td>
                        <td>{item?.ar ?? f.key}</td>
                        <td className="num font-bold">{f.count}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="قياسات خارج السماحية" subtitle="أحدث 50 قياسًا غير مطابق">
          {outOfTolerance.length === 0 ? (
            <Empty>لا توجد قياسات خارج السماحية.</Empty>
          ) : (
            <div className="scroll-x">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>الجزء</th>
                    <th>المرحلة</th>
                    <th>الخاصية</th>
                    <th>المطلوب</th>
                    <th>المقاس</th>
                    <th>الانحراف</th>
                  </tr>
                </thead>
                <tbody>
                  {outOfTolerance.map((o, oi) => (
                    <tr key={`${o.subject}-${o.measurement.featureId ?? "m"}-${oi}`}>
                      <td className="ltr text-xs font-semibold">{o.subject}</td>
                      <td className="text-xs">{stageDef(o.stage).ar}</td>
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
        title="الإفراج النهائي عن الجودة"
        subtitle="Final Quality Release"
        action={<span className="pill pill-ok">{released.length} جزء</span>}
      >
        {released.length === 0 ? (
          <Empty>لم يُفرج عن أي جزء بعد.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>الرقم المسلسل</th>
                  <th>رقم الجزء</th>
                  <th>التشغيلة</th>
                  <th>تاريخ الإفراج</th>
                  <th>الحالة</th>
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
