"use client";

import Link from "next/link";

import { ActionForm } from "@/components/ActionForm";
import { ChecklistForm } from "@/components/ChecklistForm";
import { InlineForm } from "@/components/InlineForm";
import { AnalysisPanel } from "@/components/AnalysisPanel";
import { Card, Empty, Field, Kv, PageHeader, StatusPill } from "@/components/ui";
import {
  addCertificate,
  raiseParts,
  setCertificate,
  submitLotInspection,
} from "@/lib/client/actions";
import { getLot } from "@/lib/client/queries";
import { canRaiseParts } from "@/lib/domain/inspection";
import { stageDef } from "@/lib/domain/stages";
import { fmtDate, fmtDateTime, fmtNum } from "@/lib/format";
import { Async } from "@/components/Async";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession, type SessionUser } from "@/lib/client/session";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

export default function LotPage() {
  return (
    <Suspense fallback={null}>
      <LotLoader />
    </Suspense>
  );
}

function LotLoader() {
  const user = useRequireSession();
  const id = useSearchParams().get("id") ?? "";
  const state = useAsync(() => getLot(id), [id]);

  if (!user) return null;
  return (
    <Async state={state} empty={<Empty>التشغيلة غير موجودة.</Empty>}>
      {(lot) => <LotView lot={lot} user={user} refresh={state.refresh} />}
    </Async>
  );
}

function LotView({
  lot,
  user,
  refresh,
}: {
  lot: NonNullable<Awaited<ReturnType<typeof getLot>>>;
  user: SessionUser;
  refresh: () => void;
}) {
  const receivingDef = stageDef("RAW_RECEIVING");
  const gate = canRaiseParts(lot);
  const lastReceiving = lot.inspections.find((i) => i.stage === "RAW_RECEIVING");

  return (
    <>
      <PageHeader
        title={`تشغيلة ${lot.lotNumber}`}
        subtitle={`${lot.material.partNumber}${lot.material.spec ? ` — ${lot.material.spec}` : ""}`}
        action={<StatusPill status={lot.status} />}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="بيانات الوارد">
          <Kv k="رقم الجزء" v={<span className="ltr">{lot.material.partNumber}</span>} />
          <Kv k="المواصفة" v={<span className="ltr">{lot.material.spec ?? "—"}</span>} />
          <Kv k="المورد" v={lot.supplier?.name ?? "—"} />
          <Kv k="أمر الشراء" v={<span className="ltr">{lot.poNumber ?? "—"}</span>} />
          <Kv k="رقم الصهرة" v={<span className="ltr">{lot.heatNumber ?? "—"}</span>} />
          <Kv
            k="الكمية"
            v={
              <span className="num">
                {fmtNum(lot.receivedQty)} {lot.unit}
              </span>
            }
          />
          <Kv k="تاريخ الاستلام" v={<span className="num">{fmtDate(lot.receivedAt)}</span>} />
          {lot.notes && <Kv k="ملاحظات" v={lot.notes} />}
        </Card>

        <Card
          title="الشهادات المطلوبة"
          subtitle={
            lot.missingCerts.length === 0
              ? "كل الشهادات المطلوبة مستلمة"
              : `ناقص: ${lot.missingCerts.join("، ")}`
          }
          className="lg:col-span-2"
        >
          {lot.certificates.length === 0 ? (
            <Empty>لا توجد شهادات مسجلة على هذه التشغيلة.</Empty>
          ) : (
            <ul className="grid gap-2">
              {lot.certificates.map((c) => (
                <li key={c.id} className="rounded-[var(--radius-sm)] border border-[var(--border)] p-2.5">
                  <InlineForm action={setCertificate(user)}
              onSuccess={refresh} submitLabel="حفظ">
                    <input type="hidden" name="id" value={c.id} />
                    <div className="min-w-[10rem] flex-1">
                      <div className="text-sm font-bold">{c.type}</div>
                      <div className="mt-1 flex gap-3 text-xs">
                        <label className="flex items-center gap-1">
                          <input type="checkbox" name="received" defaultChecked={c.received} /> مستلمة
                        </label>
                        <label className="flex items-center gap-1">
                          <input type="checkbox" name="verified" defaultChecked={c.verified} /> مُراجَعة
                        </label>
                      </div>
                    </div>
                    <input
                      className="input ltr w-40"
                      name="number"
                      defaultValue={c.number ?? ""}
                      placeholder="رقم الشهادة"
                    />
                    <input
                      className="input w-40"
                      name="notes"
                      defaultValue={c.notes ?? ""}
                      placeholder="ملاحظة"
                    />
                  </InlineForm>
                </li>
              ))}
            </ul>
          )}

          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-semibold text-[var(--brand)]">
              إضافة شهادة غير مدرجة
            </summary>
            <div className="mt-2 max-w-md">
              <ActionForm action={addCertificate(user)}
              onSuccess={refresh} submitLabel="إضافة" submitClassName="">
                <input type="hidden" name="lotId" value={lot.id} />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="نوع الشهادة">
                    <input className="input" name="type" required placeholder="Mill Test Certificate" />
                  </Field>
                  <Field label="رقم الشهادة">
                    <input className="input ltr" name="number" />
                  </Field>
                </div>
              </ActionForm>
            </div>
          </details>
        </Card>
      </div>

      {/* ── 1 · receiving checklist ── */}
      <Card
        className="mt-4"
        title={`${receivingDef.order}. ${receivingDef.ar}`}
        subtitle={receivingDef.en}
        action={
          lastReceiving ? (
            <span className="text-xs text-[var(--muted)]">
              آخر فحص: {lastReceiving.inspector} — {fmtDateTime(lastReceiving.inspectedAt)}
            </span>
          ) : undefined
        }
      >
        <ChecklistForm
          stage="RAW_RECEIVING"
          action={submitLotInspection(user)}
          hiddenFields={{ lotId: lot.id }}
          signatory={{ displayName: user.displayName, role: user.role }}
                onSuccess={refresh}
        />
      </Card>

      {/* ── 2 · analysis ── */}
      <AnalysisPanel lotId={lot.id} analyses={lot.analyses} user={user} onSaved={refresh} />

      {/* ── issuing parts ── */}
      <Card
        className="mt-4"
        title="إصدار الأجزاء إلى خط الإنتاج"
        subtitle="لا تُصدر الأجزاء إلا بعد قبول الاستلام واعتماد التحليل"
      >
        {!gate.ok ? (
          <p className="rounded-lg bg-[var(--warn-bg)] px-3 py-2 text-sm font-semibold text-[var(--warn-fg)]">
            {gate.reason}
          </p>
        ) : (
          <div className="max-w-xl">
            <ActionForm action={raiseParts(user)}
              onSuccess={refresh} submitLabel="إصدار الأجزاء">
              <input type="hidden" name="lotId" value={lot.id} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="بادئة الرقم المسلسل" hint="سيُضاف رقم تسلسلي من 4 خانات">
                  <input
                    className="input ltr"
                    name="prefix"
                    required
                    defaultValue={lot.lotNumber}
                  />
                </Field>
                <Field label="عدد الأجزاء">
                  <input
                    className="input num"
                    name="count"
                    type="number"
                    min="1"
                    max="500"
                    required
                    defaultValue="10"
                  />
                </Field>
              </div>
            </ActionForm>
          </div>
        )}

        {lot.parts.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-bold">
              الأجزاء الصادرة ({lot.parts.length})
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {lot.parts.map((p) => (
                <Link
                  key={p.id}
                  href={`/parts/view?id=${p.id}`}
                  className="ltr rounded-[var(--radius-sm)] border border-[var(--border)] px-2 py-1 text-xs font-semibold transition hover:border-[var(--brand)]"
                >
                  {p.serialNumber}
                </Link>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* ── history ── */}
      {lot.inspections.length > 0 && (
        <Card className="mt-4" title="سجل فحوص هذه التشغيلة">
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>المرحلة</th>
                  <th>الفاحص</th>
                  <th>الحالة</th>
                  <th>بنود غير مطابقة</th>
                  <th>التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {lot.inspections.map((i) => {
                  const failed = i.checks.filter((c) => c.ok === false);
                  return (
                    <tr key={i.id}>
                      <td>{stageDef(i.stage).ar}</td>
                      <td>{i.inspector}</td>
                      <td>
                        <StatusPill status={i.status} />
                      </td>
                      <td className="text-xs">
                        {failed.length === 0 ? (
                          <span className="text-[var(--muted)]">—</span>
                        ) : (
                          failed
                            .map(
                              (c) =>
                                stageDef(i.stage).items.find((it) => it.key === c.key)?.ar ??
                                c.key
                            )
                            .join("، ")
                        )}
                      </td>
                      <td className="num text-xs">{fmtDateTime(i.inspectedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
