import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionForm } from "@/components/ActionForm";
import { InlineForm } from "@/components/InlineForm";
import { Card, Empty, Field, Kv, PageHeader } from "@/components/ui";
import { addFeature, deleteFeature, saveMaterial } from "@/lib/server/actions";
import { getMaterial } from "@/lib/server/queries";
import { STAGE_DEFS, stageDef } from "@/lib/domain/stages";
import { fmtNum, fmtTolerance } from "@/lib/format";

export const dynamic = "force-dynamic";

const MEASURED_STAGES = STAGE_DEFS.filter((d) => d.subject === "PART");

export default async function MaterialPage({ params }: PageProps<"/materials/[id]">) {
  const { id } = await params;
  const material = await getMaterial(id);
  if (!material) notFound();

  return (
    <>
      <PageHeader
        title={material.partNumber}
        subtitle={material.description ?? material.spec ?? "مواصفة جزء"}
        action={
          <Link href="/materials" className="btn">
            كل المواصفات
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="المواصفة">
          <Kv k="رقم الخامة" v={<span className="ltr">{material.materialNumber ?? "—"}</span>} />
          <Kv k="المواصفة" v={<span className="ltr">{material.spec ?? "—"}</span>} />
          <Kv
            k="رقم الرسم"
            v={
              <span className="ltr">
                {material.drawingNumber ?? "—"}
                {material.drawingRev ? ` (${material.drawingRev})` : ""}
              </span>
            }
          />
          <Kv
            k="مدى الصلادة"
            v={
              <span className="num">
                {material.hardnessMin == null && material.hardnessMax == null
                  ? "—"
                  : `${fmtNum(material.hardnessMin)} – ${fmtNum(material.hardnessMax)} ${material.hardnessUnit}`}
              </span>
            }
          />
          <Kv
            k="Surface Finish"
            v={
              <span className="num">
                {material.surfaceFinishRa == null ? "—" : `≤ ${fmtNum(material.surfaceFinishRa)} µm Ra`}
              </span>
            }
          />
          <Kv
            k="Allowance بعد الخشونة"
            v={
              <span className="num">
                {material.roughingAllowance == null ? "—" : `${fmtNum(material.roughingAllowance)} mm`}
              </span>
            }
          />
          <Kv k="الشهادات المطلوبة" v={<span className="ltr">{material.requiredCerts ?? "—"}</span>} />
        </Card>

        <Card title="تعديل المواصفة" className="lg:col-span-2">
          <ActionForm action={saveMaterial} submitLabel="حفظ التعديلات">
            <input type="hidden" name="id" value={material.id} />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="رقم الجزء">
                <input className="input ltr" name="partNumber" required defaultValue={material.partNumber} />
              </Field>
              <Field label="رقم الخامة">
                <input className="input ltr" name="materialNumber" defaultValue={material.materialNumber ?? ""} />
              </Field>
              <Field label="المواصفة">
                <input className="input ltr" name="spec" defaultValue={material.spec ?? ""} />
              </Field>
              <Field label="رقم الرسم">
                <input className="input ltr" name="drawingNumber" defaultValue={material.drawingNumber ?? ""} />
              </Field>
              <Field label="مراجعة الرسم">
                <input className="input ltr" name="drawingRev" defaultValue={material.drawingRev ?? ""} />
              </Field>
              <Field label="الوصف">
                <input className="input" name="description" defaultValue={material.description ?? ""} />
              </Field>
              <Field label="أقل صلادة">
                <input
                  className="input num"
                  name="hardnessMin"
                  type="number"
                  step="0.1"
                  defaultValue={material.hardnessMin ?? ""}
                />
              </Field>
              <Field label="أقصى صلادة">
                <input
                  className="input num"
                  name="hardnessMax"
                  type="number"
                  step="0.1"
                  defaultValue={material.hardnessMax ?? ""}
                />
              </Field>
              <Field label="وحدة الصلادة">
                <select className="select" name="hardnessUnit" defaultValue={material.hardnessUnit}>
                  <option value="HRC">HRC</option>
                  <option value="HB">HB</option>
                  <option value="HV">HV</option>
                </select>
              </Field>
              <Field label="Ra المطلوب (µm)">
                <input
                  className="input num"
                  name="surfaceFinishRa"
                  type="number"
                  step="0.01"
                  defaultValue={material.surfaceFinishRa ?? ""}
                />
              </Field>
              <Field label="Allowance (mm)">
                <input
                  className="input num"
                  name="roughingAllowance"
                  type="number"
                  step="0.01"
                  defaultValue={material.roughingAllowance ?? ""}
                />
              </Field>
              <Field label="الشهادات المطلوبة">
                <input
                  className="input ltr"
                  name="requiredCerts"
                  defaultValue={material.requiredCerts ?? ""}
                />
              </Field>
            </div>
          </ActionForm>
        </Card>
      </div>

      {/* ── measured features per stage ── */}
      <Card
        className="mt-4"
        title="الخواص المقاسة لكل مرحلة"
        subtitle="هذه هي القياسات التي تظهر للفاحص في كشف كل مرحلة"
      >
        {MEASURED_STAGES.map((def) => {
          const rows = material.features.filter((f) => f.stage === def.stage);
          return (
            <div key={def.stage} className="mb-5 last:mb-0">
              <h3 className="mb-2 text-sm font-bold text-[var(--brand-dark)]">
                {def.order}. {def.ar}
              </h3>

              {rows.length === 0 ? (
                <Empty>لا توجد خواص مسجلة لهذه المرحلة.</Empty>
              ) : (
                <div className="scroll-x">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>الاسم</th>
                        <th>النوع</th>
                        <th>المطلوب</th>
                        <th>الوحدة</th>
                        <th>حرجة</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((f) => (
                        <tr key={f.id}>
                          <td className="font-semibold">{f.name}</td>
                          <td className="text-xs text-[var(--muted)]">
                            {f.kind === "GDT" ? `GD&T ${f.gdtSymbol ?? ""}` : "بُعد"}
                          </td>
                          <td className="num">
                            {f.kind === "GDT"
                              ? `≤ ${fmtNum(f.gdtLimit)}`
                              : fmtTolerance(f.nominal, f.tolMinus, f.tolPlus)}
                          </td>
                          <td className="ltr">{f.unit}</td>
                          <td>
                            {f.critical ? (
                              <span className="pill pill-bad">Critical</span>
                            ) : (
                              <span className="text-xs text-[var(--muted)]">—</span>
                            )}
                          </td>
                          <td>
                            <InlineForm
                              action={deleteFeature}
                              submitLabel="حذف"
                              submitClassName="btn-danger"
                              confirm={`حذف الخاصية "${f.name}"؟`}
                            >
                              <input type="hidden" name="id" value={f.id} />
                            </InlineForm>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}

        <details className="mt-3">
          <summary className="cursor-pointer text-sm font-bold text-[var(--brand)]">
            إضافة خاصية مقاسة
          </summary>
          <div className="mt-3">
            <ActionForm action={addFeature} submitLabel="إضافة الخاصية">
              <input type="hidden" name="materialId" value={material.id} />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="المرحلة">
                  <select className="select" name="stage" defaultValue="FINAL">
                    {MEASURED_STAGES.map((d) => (
                      <option key={d.stage} value={d.stage}>
                        {stageDef(d.stage).ar}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="الاسم">
                  <input className="input" name="name" required placeholder="القطر الخارجي" />
                </Field>
                <Field label="النوع">
                  <select className="select" name="kind" defaultValue="DIMENSION">
                    <option value="DIMENSION">بُعد (Dimension)</option>
                    <option value="GDT">GD&amp;T</option>
                  </select>
                </Field>
                <Field label="الوحدة">
                  <input className="input ltr" name="unit" defaultValue="mm" />
                </Field>
                <Field label="القيمة الاسمية" hint="للأبعاد فقط">
                  <input className="input num" name="nominal" type="number" step="0.0001" />
                </Field>
                <Field label="السماحية السالبة">
                  <input className="input num" name="tolMinus" type="number" step="0.0001" />
                </Field>
                <Field label="السماحية الموجبة">
                  <input className="input num" name="tolPlus" type="number" step="0.0001" />
                </Field>
                <Field label="حد الـ GD&T" hint="لخواص الـ GD&T فقط">
                  <input className="input num" name="gdtLimit" type="number" step="0.0001" />
                </Field>
                <Field label="رمز الـ GD&T">
                  <input className="input ltr" name="gdtSymbol" placeholder="⌭ / ⊥ / ⌖" />
                </Field>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 pb-2 text-sm font-semibold">
                    <input type="checkbox" name="critical" /> خاصية حرجة (Critical)
                  </label>
                </div>
              </div>
              <p className="mt-2 text-xs text-[var(--muted)]">
                الخاصية الحرجة الخارجة عن السماحية ترفض الجزء مباشرة بدلًا من إرساله لإعادة
                التشغيل.
              </p>
            </ActionForm>
          </div>
        </details>
      </Card>
    </>
  );
}
