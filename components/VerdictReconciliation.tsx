"use client";

import Link from "next/link";

import { Async } from "@/components/Async";
import { Card, StatusPill } from "@/components/ui";
import { STATUS_LABELS, stageDef } from "@/lib/domain/stages";
import { fmtDateTime } from "@/lib/format";
import { getVerdictReconciliation } from "@/lib/client/queries";
import { useAsync } from "@/lib/client/use-async";

/** Does every stored verdict still agree with its own evidence?
 *
 *  This is the compensating control for the one guarantee that did not survive
 *  moving off a server. Security rules bind a signature to its author, gate the
 *  final release, and make a filed inspection uneditable — but they cannot
 *  re-derive a checklist verdict, because they cannot iterate the measurements
 *  array or reproduce the tolerance arithmetic. So a tampered client can file a
 *  sheet claiming ACCEPTED over a failed critical feature.
 *
 *  What cannot be prevented is made impossible to hide. Every answer and every
 *  measurement is stored beside the claim, the rule is pure, and this re-runs
 *  it over the whole history. A disagreement here means the record was not
 *  written by this application as shipped.
 *
 *  It reads every inspection, so it is deliberately a button rather than
 *  something the page does on load — one scan is worth several hundred reads.
 */
export function VerdictReconciliation() {
  const state = useAsync(() => getVerdictReconciliation(), []);

  return (
    <Card
      className="mt-4 page-break"
      title="Stored verdicts, reconciled"
      subtitle="Verdict reconciliation"
    >
      <p className="mb-3 text-sm text-[var(--muted)]">
        Every inspection&rsquo;s verdict is derived again from its own answers and
        measurements, then compared with the verdict that was stored. A difference
        here means the record was not written by this application as it stands, and
        is worth looking into.
      </p>

      <Async state={state}>
        {({ disagreements, checked }) =>
          disagreements.length === 0 ? (
            <p className="rounded-lg bg-[var(--ok-bg)] px-3 py-2 text-sm font-semibold text-[var(--ok-fg)]">
              Every stored verdict agrees with its evidence. {checked} checked.
            </p>
          ) : (
            <>
              <p className="mb-3 rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm font-semibold text-[var(--bad-fg)]">
                {disagreements.length} of them disagree with what their own evidence says, out of{" "}
                {checked}.
              </p>
              <div className="scroll-x">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Part / Lot</th>
                      <th>Stage</th>
                      <th>Date</th>
                      <th>Inspector</th>
                      <th>Stored</th>
                      <th>Derived</th>
                    </tr>
                  </thead>
                  <tbody>
                    {disagreements.map(({ inspection, derived }) => (
                      <tr key={inspection.id}>
                        <td className="ltr text-xs font-semibold">
                          {inspection.partId ? (
                            <Link href={`/parts/view?id=${inspection.partId}`}>
                              {inspection.subject}
                            </Link>
                          ) : (
                            inspection.subject
                          )}
                        </td>
                        <td className="text-xs">{stageDef(inspection.stage).en}</td>
                        <td className="text-xs">{fmtDateTime(inspection.inspectedAt)}</td>
                        <td className="text-xs">{inspection.inspector}</td>
                        <td>
                          <StatusPill status={inspection.status} />
                        </td>
                        <td>
                          <StatusPill status={derived} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-[var(--muted)]">
                Derived is what the recorded answers and measurements require:{" "}
                {disagreements
                  .map(({ derived }) => STATUS_LABELS[derived as keyof typeof STATUS_LABELS]?.en)
                  .filter(Boolean)
                  .slice(0, 3)
                  .join(" · ")}
              </p>
            </>
          )
        }
      </Async>
    </Card>
  );
}
