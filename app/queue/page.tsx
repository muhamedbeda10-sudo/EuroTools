"use client";

import Link from "next/link";

import { Card, Empty, PageHeader, StatusPill } from "@/components/ui";
import { getQueues } from "@/lib/client/queries";
import { fmtDate } from "@/lib/format";
import { Async } from "@/components/Async";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession } from "@/lib/client/session";

export default function QueuePage() {
  const user = useRequireSession();
  const state = useAsync(() => getQueues(), []);

  if (!user) return null;
  return <Async state={state}>{(queues) => <QueueView queues={queues} />}</Async>;
}

function QueueView({ queues }: { queues: Awaited<ReturnType<typeof getQueues>> }) {

  return (
    <>
      <PageHeader
        title="طوابير الفحص"
        subtitle="الأجزاء الواقفة عند كل مرحلة، بالترتيب الذي تمشي به"
      />

      <div className="grid gap-4">
        {queues.map(({ stage, def, parts }) => (
          <Card
            key={stage}
            title={
              <span id={stage}>
                {def.order}. {def.ar}
              </span>
            }
            subtitle={
              def.precedingOperation
                ? `${def.en} — بعد ${def.precedingOperation.ar}`
                : def.en
            }
            action={
              <span className="pill pill-neutral">{parts.length} جزء</span>
            }
          >
            {parts.length === 0 ? (
              <Empty>لا توجد أجزاء في هذا الطابور.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>الرقم المسلسل</th>
                      <th>رقم الجزء</th>
                      <th>التشغيلة</th>
                      <th>الحالة</th>
                      <th>تاريخ الإصدار</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {parts.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link
                            href={`/parts/view?id=${p.id}`}
                            className="ltr font-bold text-[var(--brand)]"
                          >
                            {p.serialNumber}
                          </Link>
                        </td>
                        <td className="ltr">{p.material.partNumber}</td>
                        <td className="ltr text-xs">{p.lot?.lotNumber ?? "—"}</td>
                        <td>
                          <StatusPill status={p.status} />
                        </td>
                        <td className="num text-xs">{fmtDate(p.createdAt)}</td>
                        <td>
                          <Link href={`/parts/view?id=${p.id}#inspect`} className="btn">
                            فحص
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ))}
      </div>
    </>
  );
}
