import Link from "next/link";

import { ActionForm } from "@/components/ActionForm";
import { Card, Empty, Field, PageHeader } from "@/components/ui";
import { receiveLot } from "@/lib/server/actions";
import { todayInputValue } from "@/lib/format";
import { getMaterials, getSuppliers } from "@/lib/server/queries";

export const dynamic = "force-dynamic";

export default async function NewLotPage() {
  const [materials, suppliers] = await Promise.all([getMaterials(), getSuppliers()]);
  const today = todayInputValue();

  return (
    <>
      <PageHeader
        title="تسجيل استلام خامة"
        subtitle="الخطوة 1 — بيانات الوارد. كشف الفحص يُملأ بعد الحفظ."
      />

      {materials.length === 0 ? (
        <Card>
          <Empty>
            يجب تسجيل مواصفة (رقم جزء) واحدة على الأقل أولًا.{" "}
            <Link href="/materials" className="font-bold text-[var(--brand)]">
              اذهب إلى المواصفات
            </Link>
            .
          </Empty>
        </Card>
      ) : (
        <Card className="max-w-3xl">
          <ActionForm action={receiveLot} submitLabel="حفظ والانتقال لكشف الفحص">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="رقم التشغيلة / Lot No.">
                <input className="input ltr" name="lotNumber" required placeholder="LOT-2026-001" />
              </Field>

              <Field label="الخامة / رقم الجزء">
                <select className="select" name="materialId" required defaultValue="">
                  <option value="" disabled>
                    — اختر —
                  </option>
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.partNumber}
                      {m.spec ? ` — ${m.spec}` : ""}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="المورد">
                <select className="select" name="supplierId" defaultValue="">
                  <option value="">— غير محدد —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="تاريخ الاستلام">
                <input className="input num" name="receivedAt" type="date" defaultValue={today} />
              </Field>

              <Field label="الكمية المستلمة">
                <input
                  className="input num"
                  name="receivedQty"
                  type="number"
                  step="0.001"
                  min="0.001"
                  required
                />
              </Field>

              <Field label="الوحدة">
                <select className="select" name="unit" defaultValue="pcs">
                  <option value="pcs">قطعة (pcs)</option>
                  <option value="kg">كيلوجرام (kg)</option>
                  <option value="m">متر (m)</option>
                </select>
              </Field>

              <Field label="رقم أمر الشراء / PO">
                <input className="input ltr" name="poNumber" />
              </Field>

              <Field label="رقم الصهرة / Heat No." hint="من شهادة المصنع">
                <input className="input ltr" name="heatNumber" />
              </Field>
            </div>

            <div className="mt-3">
              <Field label="ملاحظات">
                <textarea className="textarea" name="notes" rows={2} />
              </Field>
            </div>

            <p className="mt-3 text-xs text-[var(--muted)]">
              الشهادات المطلوبة في مواصفة الجزء ستُضاف تلقائيًا كبنود بانتظار الاستلام.
            </p>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
