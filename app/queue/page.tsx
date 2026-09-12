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
        title="Inspection Queue"
        subtitle="Parts waiting at each stage, in the order a traveller walks them"
      />

      <div className="grid gap-4">
        {queues.map(({ stage, def, parts }) => (
          <Card
            key={stage}
            title={
              <span id={stage}>
                {def.order}. {def.en}
              </span>
            }
            subtitle={
              def.precedingOperation
                ? `${def.en} — after ${def.precedingOperation.en}`
                : def.en
            }
            action={
              <span className="pill pill-neutral">{parts.length} parts</span>
            }
          >
            {parts.length === 0 ? (
              <Empty>Nothing waiting at this stage.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Serial number</th>
                      <th>Part number</th>
                      <th>Lot</th>
                      <th>Status</th>
                      <th>Raised</th>
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
                            Inspect
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
