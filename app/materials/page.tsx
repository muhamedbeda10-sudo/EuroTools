"use client";

import Link from "next/link";

import { ActionForm } from "@/components/ActionForm";
import { Card, Empty, Field, PageHeader } from "@/components/ui";
import { saveMaterial, saveSupplier } from "@/lib/client/actions";
import { getMaterials, getSuppliers } from "@/lib/client/queries";
import { fmtNum } from "@/lib/format";
import { Async } from "@/components/Async";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession, type SessionUser } from "@/lib/client/session";

export default function MaterialsPage() {
  const user = useRequireSession();
  const state = useAsync(
    async () => ({
      materials: await getMaterials(),
      suppliers: await getSuppliers(),
    }),
    []
  );

  if (!user) return null;
  return (
    <Async state={state}>
      {({ materials, suppliers }) => (
        <MaterialsView
          materials={materials}
          suppliers={suppliers}
          user={user}
          refresh={state.refresh}
        />
      )}
    </Async>
  );
}

function MaterialsView({
  materials,
  suppliers,
  user,
  refresh,
}: {
  materials: Awaited<ReturnType<typeof getMaterials>>;
  suppliers: Awaited<ReturnType<typeof getSuppliers>>;
  user: SessionUser;
  refresh: () => void;
}) {

  return (
    <>
      <PageHeader
        title="المواصفات والموردون"
        subtitle="رقم الجزء، المواصفة، مدى الصلادة، الشهادات المطلوبة، والخواص المقاسة"
      />

      <Card
        title="أرقام الأجزاء"
        action={<span className="pill pill-neutral">{materials.length}</span>}
      >
        {materials.length === 0 ? (
          <Empty>لا توجد مواصفات مسجلة. أضف واحدة من النموذج بالأسفل.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>رقم الجزء</th>
                  <th>المواصفة</th>
                  <th>رقم الرسم</th>
                  <th>مدى الصلادة</th>
                  <th>Ra المطلوب</th>
                  <th>الشهادات</th>
                  <th>الخواص</th>
                  <th>تشغيلات / أجزاء</th>
                </tr>
              </thead>
              <tbody>
                {materials.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Link
                        href={`/materials/view?id=${m.id}`}
                        className="ltr font-bold text-[var(--brand)]"
                      >
                        {m.partNumber}
                      </Link>
                      {m.description && (
                        <div className="text-xs text-[var(--muted)]">{m.description}</div>
                      )}
                    </td>
                    <td className="ltr">{m.spec ?? "—"}</td>
                    <td className="ltr">
                      {m.drawingNumber ?? "—"}
                      {m.drawingRev ? ` (${m.drawingRev})` : ""}
                    </td>
                    <td className="num">
                      {m.hardnessMin == null && m.hardnessMax == null
                        ? "—"
                        : `${fmtNum(m.hardnessMin)} – ${fmtNum(m.hardnessMax)} ${m.hardnessUnit}`}
                    </td>
                    <td className="num">
                      {m.surfaceFinishRa == null ? "—" : `≤ ${fmtNum(m.surfaceFinishRa)}`}
                    </td>
                    <td className="ltr text-xs">{m.requiredCerts ?? "—"}</td>
                    <td className="num">{m.features.length}</td>
                    <td className="num text-xs">
                      {m._count.lots} / {m._count.parts}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title="إضافة مواصفة جديدة" className="lg:col-span-2">
          <ActionForm action={saveMaterial(user)}
              onSuccess={refresh} submitLabel="حفظ المواصفة">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="رقم الجزء / Part No.">
                <input className="input ltr" name="partNumber" required placeholder="PN-1042-A" />
              </Field>
              <Field label="رقم الخامة / Material No.">
                <input className="input ltr" name="materialNumber" />
              </Field>
              <Field label="المواصفة / Spec">
                <input className="input ltr" name="spec" placeholder="DIN 1.2379" />
              </Field>
              <Field label="رقم الرسم / Drawing No.">
                <input className="input ltr" name="drawingNumber" />
              </Field>
              <Field label="مراجعة الرسم / Rev">
                <input className="input ltr" name="drawingRev" placeholder="B" />
              </Field>
              <Field label="الوصف">
                <input className="input" name="description" />
              </Field>
              <Field label="أقل صلادة">
                <input className="input num" name="hardnessMin" type="number" step="0.1" />
              </Field>
              <Field label="أقصى صلادة">
                <input className="input num" name="hardnessMax" type="number" step="0.1" />
              </Field>
              <Field label="وحدة الصلادة">
                <select className="select" name="hardnessUnit" defaultValue="HRC">
                  <option value="HRC">HRC</option>
                  <option value="HB">HB</option>
                  <option value="HV">HV</option>
                </select>
              </Field>
              <Field label="Surface Finish المطلوب (Ra µm)">
                <input className="input num" name="surfaceFinishRa" type="number" step="0.01" />
              </Field>
              <Field label="Allowance بعد الخشونة (mm)">
                <input className="input num" name="roughingAllowance" type="number" step="0.01" />
              </Field>
              <Field
                label="الشهادات المطلوبة"
                hint="مفصولة بفواصل — تُنشأ تلقائيًا مع كل تشغيلة"
              >
                <input
                  className="input ltr"
                  name="requiredCerts"
                  placeholder="Mill Test Certificate, Heat Treatment"
                />
              </Field>
            </div>
          </ActionForm>
        </Card>

        <Card title="الموردون" action={<span className="pill pill-neutral">{suppliers.length}</span>}>
          {suppliers.length > 0 && (
            <ul className="mb-3 grid gap-1 text-sm">
              {suppliers.map((s) => (
                <li key={s.id} className="border-b border-[var(--border)] pb-1 last:border-0">
                  <span className="font-semibold">{s.name}</span>
                  {s.code && <span className="ltr ms-2 text-xs text-[var(--muted)]">{s.code}</span>}
                </li>
              ))}
            </ul>
          )}
          <ActionForm action={saveSupplier(user)}
              onSuccess={refresh} submitLabel="إضافة مورد" submitClassName="">
            <div className="grid gap-2">
              <Field label="اسم المورد">
                <input className="input" name="name" required />
              </Field>
              <Field label="الكود">
                <input className="input ltr" name="code" />
              </Field>
              <Field label="جهة الاتصال">
                <input className="input" name="contact" />
              </Field>
            </div>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
