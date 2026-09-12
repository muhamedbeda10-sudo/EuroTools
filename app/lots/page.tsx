"use client";

import Link from "next/link";

import { Card, Empty, PageHeader, StatusPill } from "@/components/ui";
import { getLots } from "@/lib/client/queries";
import { fmtDate, fmtNum } from "@/lib/format";
import { Async } from "@/components/Async";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession } from "@/lib/client/session";

export default function LotsPage() {
  const user = useRequireSession();
  const state = useAsync(() => getLots(), []);

  if (!user) return null;
  return <Async state={state}>{(lots) => <LotsView lots={lots} />}</Async>;
}

function LotsView({ lots }: { lots: Awaited<ReturnType<typeof getLots>> }) {

  return (
    <>
      <PageHeader
        title="Goods In"
        subtitle="Raw material receiving — every incoming lot and where it stands"
        action={
          <Link href="/lots/new" className="btn btn-primary">
            Receive a lot
          </Link>
        }
      />

      <Card>
        {lots.length === 0 ? (
          <Empty>
            No lots recorded yet.{" "}
            <Link href="/lots/new" className="font-bold text-[var(--brand)]">
              Receive the first one
            </Link>
            .
          </Empty>
        ) : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Lot number</th>
                  <th>Part number</th>
                  <th>Supplier</th>
                  <th>Quantity</th>
                  <th>Received</th>
                  <th>Certificates</th>
                  <th>Analysis</th>
                  <th>Parts</th>
                  <th>Status</th>
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
                          href={`/lots/view?id=${l.id}`}
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
                          <span className="pill pill-ok">Complete</span>
                        ) : (
                          <span className="pill pill-warn">
                            {l.missingCerts.length} missing
                          </span>
                        )}
                      </td>
                      <td>
                        {analysisState === "—" ? (
                          <span className="text-xs text-[var(--muted)]">None</span>
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
