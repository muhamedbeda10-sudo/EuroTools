"use client";

import Link from "next/link";

import { ActionForm } from "@/components/ActionForm";
import { InlineForm } from "@/components/InlineForm";
import { Card, Empty, Field, Kv, PageHeader } from "@/components/ui";
import { addFeature, deleteFeature, saveMaterial } from "@/lib/client/actions";
import { getMaterial } from "@/lib/client/queries";
import { STAGE_DEFS, stageDef } from "@/lib/domain/stages";
import { fmtNum, fmtTolerance } from "@/lib/format";
import { Async } from "@/components/Async";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession, type SessionUser } from "@/lib/client/session";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const MEASURED_STAGES = STAGE_DEFS.filter((d) => d.subject === "PART");

export default function MaterialPage() {
  return (
    <Suspense fallback={null}>
      <MaterialLoader />
    </Suspense>
  );
}

function MaterialLoader() {
  const user = useRequireSession();
  const id = useSearchParams().get("id") ?? "";
  const state = useAsync(() => getMaterial(id), [id]);

  if (!user) return null;
  return (
    <Async state={state} empty={<Empty>That specification does not exist.</Empty>}>
      {(material) => <MaterialView material={material} user={user} refresh={state.refresh} />}
    </Async>
  );
}

function MaterialView({
  material,
  user,
  refresh,
}: {
  material: NonNullable<Awaited<ReturnType<typeof getMaterial>>>;
  user: SessionUser;
  refresh: () => void;
}) {

  return (
    <>
      <PageHeader
        title={material.partNumber}
        subtitle={material.description ?? material.spec ?? "Part specification"}
        action={
          <Link href="/materials" className="btn">
            All specifications
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Specification">
          <Kv k="Material number" v={<span className="ltr">{material.materialNumber ?? "—"}</span>} />
          <Kv k="Specification" v={<span className="ltr">{material.spec ?? "—"}</span>} />
          <Kv
            k="Drawing number"
            v={
              <span className="ltr">
                {material.drawingNumber ?? "—"}
                {material.drawingRev ? ` (${material.drawingRev})` : ""}
              </span>
            }
          />
          <Kv
            k="Hardness range"
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
            k="Allowance after roughing"
            v={
              <span className="num">
                {material.roughingAllowance == null ? "—" : `${fmtNum(material.roughingAllowance)} mm`}
              </span>
            }
          />
          <Kv k="Required certificates" v={<span className="ltr">{material.requiredCerts ?? "—"}</span>} />
        </Card>

        <Card title="Edit specification" className="lg:col-span-2">
          <ActionForm action={saveMaterial(user)}
              onSuccess={refresh} submitLabel="Save changes">
            <input type="hidden" name="id" value={material.id} />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Part number">
                <input className="input ltr" name="partNumber" required defaultValue={material.partNumber} />
              </Field>
              <Field label="Material number">
                <input className="input ltr" name="materialNumber" defaultValue={material.materialNumber ?? ""} />
              </Field>
              <Field label="Specification">
                <input className="input ltr" name="spec" defaultValue={material.spec ?? ""} />
              </Field>
              <Field label="Drawing number">
                <input className="input ltr" name="drawingNumber" defaultValue={material.drawingNumber ?? ""} />
              </Field>
              <Field label="Drawing revision">
                <input className="input ltr" name="drawingRev" defaultValue={material.drawingRev ?? ""} />
              </Field>
              <Field label="Description">
                <input className="input" name="description" defaultValue={material.description ?? ""} />
              </Field>
              <Field label="Minimum hardness">
                <input
                  className="input num"
                  name="hardnessMin"
                  type="number"
                  step="0.1"
                  defaultValue={material.hardnessMin ?? ""}
                />
              </Field>
              <Field label="Maximum hardness">
                <input
                  className="input num"
                  name="hardnessMax"
                  type="number"
                  step="0.1"
                  defaultValue={material.hardnessMax ?? ""}
                />
              </Field>
              <Field label="Hardness unit">
                <select className="select" name="hardnessUnit" defaultValue={material.hardnessUnit}>
                  <option value="HRC">HRC</option>
                  <option value="HB">HB</option>
                  <option value="HV">HV</option>
                </select>
              </Field>
              <Field label="Required Ra (µm)">
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
              <Field label="Required certificates">
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
        title="Measured features, by stage"
        subtitle="These are the measurements an inspector is asked for on each stage sheet"
      >
        {MEASURED_STAGES.map((def) => {
          const rows = material.features.filter((f) => f.stage === def.stage);
          return (
            <div key={def.stage} className="mb-5 last:mb-0">
              <h3 className="mb-2 text-sm font-bold text-[var(--brand-dark)]">
                {def.order}. {def.en}
              </h3>

              {rows.length === 0 ? (
                <Empty>No features recorded for this stage.</Empty>
              ) : (
                <div className="scroll-x">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Type</th>
                        <th>Required</th>
                        <th>Unit</th>
                        <th>Critical</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((f) => (
                        <tr key={f.id}>
                          <td className="font-semibold">{f.name}</td>
                          <td className="text-xs text-[var(--muted)]">
                            {f.kind === "GDT" ? `GD&T ${f.gdtSymbol ?? ""}` : "Dimension"}
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
                              action={deleteFeature(user)}
              onSuccess={refresh}
                              submitLabel="Remove"
                              submitClassName="btn-danger"
                              confirm={`Remove the feature "${f.name}"?`}
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
            Add a measured feature
          </summary>
          <div className="mt-3">
            <ActionForm action={addFeature(user)}
              onSuccess={refresh} submitLabel="Add feature">
              <input type="hidden" name="materialId" value={material.id} />
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Stage">
                  <select className="select" name="stage" defaultValue="FINAL">
                    {MEASURED_STAGES.map((d) => (
                      <option key={d.stage} value={d.stage}>
                        {stageDef(d.stage).en}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Name">
                  <input className="input" name="name" required placeholder="Outside diameter" />
                </Field>
                <Field label="Type">
                  <select className="select" name="kind" defaultValue="DIMENSION">
                    <option value="DIMENSION">Dimension</option>
                    <option value="GDT">GD&amp;T</option>
                  </select>
                </Field>
                <Field label="Unit">
                  <input className="input ltr" name="unit" defaultValue="mm" />
                </Field>
                <Field label="Nominal" hint="Dimensions only">
                  <input className="input num" name="nominal" type="number" step="0.0001" />
                </Field>
                <Field label="Tolerance minus">
                  <input className="input num" name="tolMinus" type="number" step="0.0001" />
                </Field>
                <Field label="Tolerance plus">
                  <input className="input num" name="tolPlus" type="number" step="0.0001" />
                </Field>
                <Field label="GD&T limit" hint="GD&T features only">
                  <input className="input num" name="gdtLimit" type="number" step="0.0001" />
                </Field>
                <Field label="GD&T symbol">
                  <input className="input ltr" name="gdtSymbol" placeholder="⌭ / ⊥ / ⌖" />
                </Field>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 pb-2 text-sm font-semibold">
                    <input type="checkbox" name="critical" /> Critical feature
                  </label>
                </div>
              </div>
              <p className="mt-2 text-xs text-[var(--muted)]">
                A critical feature outside tolerance rejects the part outright, rather than
                sending it back for rework.
              </p>
            </ActionForm>
          </div>
        </details>
      </Card>
    </>
  );
}
