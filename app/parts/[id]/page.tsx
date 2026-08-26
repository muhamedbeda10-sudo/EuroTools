import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionForm } from "@/components/ActionForm";
import { ChecklistForm, type FeatureRow } from "@/components/ChecklistForm";
import { PrintButton } from "@/components/PrintButton";
import { Card, Empty, Kv, PageHeader, StatusPill } from "@/components/ui";
import { returnPartToQueue, submitPartInspection } from "@/lib/server/actions";
import { getPart } from "@/lib/server/queries";
import { canInspect, measurementResult } from "@/lib/domain/inspection";
import { GROUP_LABELS, PART_STAGES, stageDef, type Stage } from "@/lib/domain/stages";
import { fmtDate, fmtDateTime, fmtNum, fmtTolerance, pct } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PartPage({ params }: PageProps<"/parts/[id]">) {
  const { id } = await params;
  const part = await getPart(Number(id));
  if (!part) notFound();

  const stage = part.currentStage as Stage | "DONE";
  const gate =
    stage === "DONE"
      ? { ok: false, reason: "انتهت مراحل هذا الجزء." }
      : canInspect(part, stage);

  // `inspections` comes back newest-first from the query layer.
  const latest = part.inspections[0];

  const features: FeatureRow[] =
    stage === "DONE"
      ? []
      : part.material.features
          .filter((f) => f.stage === stage)
          .map((f) => ({
            id: f.id,
            name: f.name,
            kind: f.kind,
            nominal: f.nominal,
            tolMinus: f.tolMinus,
            tolPlus: f.tolPlus,
            gdtLimit: f.gdtLimit,
            gdtSymbol: f.gdtSymbol,
            unit: f.unit,
            critical: f.critical,
          }));

  return (
    <>
      <PageHeader
        title={`جزء ${part.serialNumber}`}
        subtitle={`${part.material.partNumber}${
          part.material.drawingNumber ? ` — رسم ${part.material.drawingNumber}` : ""
        }`}
        action={
          <div className="flex items-center gap-2">
            <PrintButton />
            <StatusPill status={part.status} />
          </div>
        }
      />

      {/* ── traveller ── */}
      <Card className="mb-4" title="مسار الجزء">
        <ol className="grid gap-2 sm:grid-cols-4">
          {PART_STAGES.map((s, i) => {
            const def = stageDef(s);
            const done =
              part.currentStage === "DONE" || PART_STAGES.indexOf(s) < PART_STAGES.indexOf(part.currentStage as Stage);
            const here = part.currentStage === s;
            return (
              <li
                key={s}
                className={`rounded-[var(--radius-sm)] border p-3 ${
                  here
                    ? "border-[var(--brand)] bg-[var(--brand-light)]"
                    : done
                      ? "border-[var(--ok-fg)]"
                      : "border-[var(--border)]"
                }`}
              >
                <div className="text-xs font-semibold text-[var(--muted)]">
                  المرحلة {i + 1}
                </div>
                <div className="mt-0.5 text-sm font-bold">{def.ar}</div>
                <div className="mt-1 text-xs">
                  {done ? (
                    <span className="text-[var(--ok-fg)]">✓ تمت</span>
                  ) : here ? (
                    <span className="text-[var(--brand-dark)]">الموقع الحالي</span>
                  ) : (
                    <span className="text-[var(--muted)]">لم تبدأ</span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        <div className="mt-3 flex items-center gap-2">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
            <div
              className="h-full rounded-full bg-[var(--brand)]"
              style={{ width: `${part.progress * 100}%` }}
            />
          </div>
          <span className="num text-sm font-bold">{pct(part.progress)}</span>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="بيانات الجزء">
          <Kv k="الرقم المسلسل" v={<span className="ltr">{part.serialNumber}</span>} />
          <Kv k="رقم الجزء" v={<span className="ltr">{part.material.partNumber}</span>} />
          <Kv k="رقم الرسم" v={<span className="ltr">{part.material.drawingNumber ?? "—"}</span>} />
          <Kv k="المواصفة" v={<span className="ltr">{part.material.spec ?? "—"}</span>} />
          <Kv
            k="التشغيلة"
            v={
              part.lot ? (
                <Link href={`/lots/${part.lot.id}`} className="ltr text-[var(--brand)]">
                  {part.lot.lotNumber}
                </Link>
              ) : (
                "—"
              )
            }
          />
          <Kv k="المورد" v={part.lot?.supplier?.name ?? "—"} />
          <Kv k="تاريخ الإصدار" v={<span className="num">{fmtDate(part.createdAt)}</span>} />
          <Kv
            k="مدى الصلادة المطلوب"
            v={
              <span className="num">
                {part.material.hardnessMin == null && part.material.hardnessMax == null
                  ? "—"
                  : `${fmtNum(part.material.hardnessMin)} – ${fmtNum(part.material.hardnessMax)} ${part.material.hardnessUnit}`}
              </span>
            }
          />
          <Kv
            k="Surface Finish المطلوب"
            v={
              <span className="num">
                {part.material.surfaceFinishRa == null
                  ? "—"
                  : `≤ ${fmtNum(part.material.surfaceFinishRa)} µm Ra`}
              </span>
            }
          />
        </Card>

        {/* ── inspection form ── */}
        <div className="lg:col-span-2" id="inspect">
          {gate.ok && stage !== "DONE" ? (
            <Card
              title={`${stageDef(stage).order}. ${stageDef(stage).ar}`}
              subtitle={stageDef(stage).en}
            >
              <ChecklistForm
                stage={stage}
                action={submitPartInspection}
                hiddenFields={{ partId: part.id, stage }}
                features={features}
                hardnessRange={
                  stage === "HEAT_TREATMENT"
                    ? {
                        min: part.material.hardnessMin,
                        max: part.material.hardnessMax,
                        unit: part.material.hardnessUnit,
                      }
                    : undefined
                }
                requiredRa={stage === "FINAL" ? part.material.surfaceFinishRa : null}
              />
            </Card>
          ) : (
            <Card title="الفحص غير متاح">
              {/* After a submit the checklist is replaced by this card, so the
                  last verdict is repeated here — otherwise the inspector loses
                  the confirmation of what they just recorded. */}
              {latest && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-2)] px-3 py-2">
                  <span className="text-sm font-semibold">آخر فحص مُسجَّل:</span>
                  <span className="text-sm">{stageDef(latest.stage).ar}</span>
                  <StatusPill status={latest.status} />
                  <span className="text-xs text-[var(--muted)]">
                    {latest.inspector} · {fmtDateTime(latest.inspectedAt)}
                  </span>
                </div>
              )}

              <p className="rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-sm font-semibold text-[var(--warn-fg)]">
                {gate.reason}
              </p>

              {(part.status === "REWORK" || part.status === "HOLD") && (
                <div className="mt-4 max-w-sm">
                  <p className="mb-2 text-sm text-[var(--muted)]">
                    بعد إتمام المعالجة في الورشة، أعِد الجزء إلى الطابور ليُفحص مرة أخرى في
                    نفس المرحلة.
                  </p>
                  <ActionForm
                    action={returnPartToQueue}
                    submitLabel="إعادة إلى طابور الفحص"
                    submitClassName="btn-primary"
                  >
                    <input type="hidden" name="partId" value={part.id} />
                    <input className="input" name="actor" placeholder="الاسم (اختياري)" />
                  </ActionForm>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      {/* ── history ── */}
      <Card className="mt-4 page-break" title="سجل الفحوص">
        {part.inspections.length === 0 ? (
          <Empty>لم يُسجَّل أي فحص على هذا الجزء بعد.</Empty>
        ) : (
          <div className="grid gap-4">
            {part.inspections.map((insp) => {
              const def = stageDef(insp.stage);
              return (
                <div
                  key={insp.id}
                  className="rounded-[var(--radius-sm)] border border-[var(--border-strong)] p-3"
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-bold">
                        {def.order}. {def.ar}
                      </span>
                      <span className="ms-2 text-xs text-[var(--muted)]">
                        {insp.inspector} · {fmtDateTime(insp.inspectedAt)}
                      </span>
                    </div>
                    <StatusPill status={insp.status} />
                  </div>

                  {insp.hardnessValue != null && (
                    <p className="num mb-2 text-sm">
                      الصلادة المقاسة: <strong>{fmtNum(insp.hardnessValue)} {insp.hardnessUnit}</strong>
                      {" — "}المدى المطلوب: {fmtNum(insp.hardnessMin)} – {fmtNum(insp.hardnessMax)}
                    </p>
                  )}
                  {insp.surfaceFinishRa != null && (
                    <p className="num mb-2 text-sm">
                      Surface Finish: <strong>{fmtNum(insp.surfaceFinishRa)} µm Ra</strong>
                    </p>
                  )}
                  {insp.cmmReportRef && (
                    <p className="mb-2 text-sm">
                      تقرير CMM: <span className="ltr font-bold">{insp.cmmReportRef}</span>
                      {insp.cmmReviewed ? " — تمت المراجعة" : " — لم تُراجع بعد"}
                    </p>
                  )}

                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <h4 className="mb-1 text-xs font-bold text-[var(--muted)]">بنود الكشف</h4>
                      <ul className="grid gap-0.5 text-xs">
                        {def.items.map((item) => {
                          const c = insp.checks.find((x) => x.key === item.key);
                          const mark =
                            c?.ok === true ? "✓" : c?.ok === false ? "✕" : "–";
                          const tone =
                            c?.ok === true
                              ? "text-[var(--ok-fg)]"
                              : c?.ok === false
                                ? "text-[var(--bad-fg)]"
                                : "text-[var(--muted)]";
                          return (
                            <li key={item.key} className="flex gap-2">
                              <span className={`font-bold ${tone}`}>{mark}</span>
                              <span>
                                {item.group && (
                                  <span className="text-[var(--muted)]">
                                    [{GROUP_LABELS[item.group]?.ar ?? item.group}]{" "}
                                  </span>
                                )}
                                {item.ar}
                                {c?.note && (
                                  <span className="text-[var(--muted)]"> — {c.note}</span>
                                )}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>

                    {insp.measurements.length > 0 && (
                      <div>
                        <h4 className="mb-1 text-xs font-bold text-[var(--muted)]">القياسات</h4>
                        <div className="scroll-x">
                          <table className="tbl">
                            <thead>
                              <tr>
                                <th>الخاصية</th>
                                <th>المطلوب</th>
                                <th>المقاس</th>
                                <th>النتيجة</th>
                              </tr>
                            </thead>
                            <tbody>
                              {insp.measurements.map((m) => (
                                <tr key={m.id}>
                                  <td>
                                    {m.name}
                                    {m.critical && (
                                      <span className="pill pill-bad ms-1">C</span>
                                    )}
                                  </td>
                                  <td className="num">
                                    {m.kind === "GDT"
                                      ? `≤ ${fmtNum(m.gdtLimit)}`
                                      : fmtTolerance(m.nominal, m.tolMinus, m.tolPlus)}{" "}
                                    {m.unit}
                                  </td>
                                  <td className="num">{fmtNum(m.actual)}</td>
                                  <td>
                                    <StatusPill status={measurementResult(m)} />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>

                  {insp.notes && (
                    <p className="mt-2 text-sm text-[var(--muted)]">ملاحظات: {insp.notes}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="mt-4" title="سجل الحركة">
        <ul className="grid gap-1.5 text-sm">
          {part.events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-2 border-b border-[var(--border)] pb-1.5 last:border-0">
              <span className="num text-xs text-[var(--muted)]">{fmtDateTime(e.at)}</span>
              <span className="font-semibold">{e.note ?? e.kind}</span>
              {e.actor && <span className="text-xs text-[var(--muted)]">— {e.actor}</span>}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
