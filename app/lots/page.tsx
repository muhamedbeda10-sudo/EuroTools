import Link from "next/link";

import { Card, Empty, PageHeader, StatusPill } from "@/components/ui";
import { getLots } from "@/lib/server/queries";
import { fmtDate, fmtNum } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function LotsPage() {
  const lots = await getLots();

  return (
    <>
      <PageHeader
        title="استلام الخامات"
        subtitle="Raw Material Receiving — كل تشغيلة واردة وحالتها"
        action={
          <Link href="/lots/new" className="btn btn-primary">
            تسجيل استلام جديد
          </Link>
        }
      />

      <Card>
        {lots.length === 0 ? (
          <Empty>
            لا توجد تشغيلات مسجلة.{" "}
            <Link href="/lots/new" className="font-bold text-[var(--brand)]">
              سجّل أول استلام
            </Link>
            .
          </Empty>
        ) : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>رقم التشغيلة</th>
                  <th>رقم الجزء</th>
                  <th>المورد</th>
                  <th>الكمية</th>
                  <th>تاريخ الاستلام</th>
                  <th>الشهادات</th>
                  <th>التحليل</th>
                  <th>الأجزاء</th>
                  <th>الحالة</th>
                </tr>
              </thead>
              <tbody>
                {lots.map((l) => {
                  const analysisState =
                    l.analyses.length === 0
                      ? "—"
                      : l.analyses.some((a) => a.status === "REJECTED")
                        ? "REJECTED"
                        : l.analyses.some((a) => a.status === "ACCEPTED")
                          ? "ACCEPTED"
                          : "PENDING";
                  return (
                    <tr key={l.id}>
                      <td>
                        <Link
                          href={`/lots/${l.id}`}
                          className="ltr font-bold text-[var(--brand)]"
                        >
                          {l.lotNumber}
                        </Link>
                      </td>
                      <td className="ltr">{l.material.partNumber}</td>
                      <td>{l.supplier?.name ?? "—"}</td>
                      <td className="num">
                        {fmtNum(l.receivedQty)} {l.unit}
                      </td>
                      <td className="num text-xs">{fmtDate(l.receivedAt)}</td>
                      <td>
                        {l.missingCerts.length === 0 ? (
                          <span className="pill pill-ok">مكتملة</span>
                        ) : (
                          <span className="pill pill-warn">
                            ناقص {l.missingCerts.length}
                          </span>
                        )}
                      </td>
                      <td>
                        {analysisState === "—" ? (
                          <span className="text-xs text-[var(--muted)]">لا يوجد</span>
                        ) : (
                          <StatusPill status={analysisState} />
                        )}
                      </td>
                      <td className="num">{l._count.parts}</td>
                      <td>
                        <StatusPill status={l.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
