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
      title="مطابقة النتائج المخزّنة"
      subtitle="Verdict reconciliation"
    >
      <p className="mb-3 text-sm text-[var(--muted)]">
        يُعيد النظام اشتقاق نتيجة كل فحص من بنوده وقياساته ويقارنها بالنتيجة المحفوظة. أي
        اختلاف هنا معناه أن السجل لم يُكتب من التطبيق كما هو، ويستحق المراجعة.
      </p>

      <Async state={state}>
        {({ disagreements, checked }) =>
          disagreements.length === 0 ? (
            <p className="rounded-lg bg-[var(--ok-bg)] px-3 py-2 text-sm font-semibold text-[var(--ok-fg)]">
              كل النتائج مطابقة — تمت مراجعة {checked} فحصًا.
            </p>
          ) : (
            <>
              <p className="mb-3 rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm font-semibold text-[var(--bad-fg)]">
                {disagreements.length} سجل لا تطابق نتيجته المحفوظة ما تقوله بياناته — من أصل{" "}
                {checked}.
              </p>
              <div className="scroll-x">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>الجزء / التشغيلة</th>
                      <th>المرحلة</th>
                      <th>التاريخ</th>
                      <th>الفاحص</th>
                      <th>المحفوظة</th>
                      <th>المحسوبة</th>
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
                        <td className="text-xs">{stageDef(inspection.stage).ar}</td>
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
                المحسوبة هي ما تقتضيه البنود والقياسات المسجّلة:{" "}
                {disagreements
                  .map(({ derived }) => STATUS_LABELS[derived as keyof typeof STATUS_LABELS]?.ar)
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
