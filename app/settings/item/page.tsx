"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Async } from "@/components/Async";
import { Card, Empty } from "@/components/ui";
import { allows } from "@/lib/domain/roles";
import { STAGES, STAGE_LABELS, type Stage } from "@/lib/domain/workflow";
import { saveItemConfig } from "@/lib/client/actions";
import { getDepartments, getItemConfig } from "@/lib/client/queries";
import type { DefectSpec, DimensionSpec } from "@/lib/model";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession, type SessionUser } from "@/lib/client/session";

/** What one item has to be.
 *
 *  Saved whole rather than row by row: a dimension deleted here has to stop
 *  appearing on the next sheet, and a merge would leave it there. Sheets
 *  already signed keep their own copy of the drawing, so nothing historical
 *  moves when this changes — which is the whole reason an inspection copies
 *  its specification instead of pointing at one.
 */
function ItemEditor({ code }: { code: string | null }) {
  const me = useRequireSession();
  const state = useAsync(
    async () => ({
      item: code ? await getItemConfig(code) : null,
      departments: await getDepartments(),
    }),
    [code]
  );
  if (!me) return null;
  if (!allows(me, "config.manage"))
    return <Empty>Changing what a piece has to be needs a quality manager.</Empty>;

  return (
    <Async state={state}>
      {(d) => (
        <Editor
          me={me}
          code={code}
          item={d.item}
          departments={d.departments}
          onSaved={state.refresh}
        />
      )}
    </Async>
  );
}

type DimRow = DimensionSpec & { rowId: string };
type DefRow = DefectSpec & { rowId: string };

let counter = 0;
const rowId = () => `r${(counter += 1)}_${Date.now().toString(36)}`;

function Editor({
  me,
  code,
  item,
  departments,
  onSaved,
}: {
  me: SessionUser;
  code: string | null;
  item: Awaited<ReturnType<typeof getItemConfig>>;
  departments: string[];
  onSaved: () => void;
}) {
  const [dims, setDims] = useState<Record<Stage, DimRow[]>>(() => ({
    ROUGHING: (item?.dimensions?.ROUGHING ?? []).map((d) => ({ ...d, rowId: rowId() })),
    FINISH: (item?.dimensions?.FINISH ?? []).map((d) => ({ ...d, rowId: rowId() })),
  }));
  const [defects, setDefects] = useState<DefRow[]>(() =>
    (item?.defects ?? []).map((d) => ({ ...d, rowId: rowId() }))
  );

  const blankDim = (): DimRow => ({
    rowId: rowId(),
    key: "",
    name: "",
    unit: "mm",
    nominal: null,
    tolMinus: null,
    tolPlus: null,
  });

  const setDim = (stage: Stage, id: string, patch: Partial<DimRow>) =>
    setDims((all) => ({
      ...all,
      [stage]: all[stage].map((r) => (r.rowId === id ? { ...r, ...patch } : r)),
    }));

  return (
    <>

      <ActionForm action={saveItemConfig(me)} onSuccess={onSaved} submitLabel="Save the item">
        <Card title="Item">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="itemCode">Item code</label>
              <input
                id="itemCode"
                className="input ltr"
                name="itemCode"
                defaultValue={item?.itemCode ?? code ?? ""}
                readOnly={Boolean(item)}
                required
                placeholder="Core"
              />
              {item && (
                <p className="mt-1 text-xs text-[var(--muted)]">
                  The code is what planning&rsquo;s sheet matches on, so it cannot be changed here.
                </p>
              )}
            </div>
            <div>
              <label className="label" htmlFor="itemName">Name</label>
              <input
                id="itemName"
                className="input"
                name="itemName"
                defaultValue={item?.itemName ?? ""}
                placeholder="Core insert"
              />
            </div>
          </div>
        </Card>

        {STAGES.map((stage) => (
          <Card
            key={stage}
            className="mt-4"
            title={`${STAGE_LABELS[stage]} dimensions`}
            action={
              <button
                type="button"
                className="btn"
                onClick={() => setDims((all) => ({ ...all, [stage]: [...all[stage], blankDim()] }))}
              >
                + Add
              </button>
            }
          >
            {dims[stage].length === 0 ? (
              <Empty>Nothing measured at this stage yet.</Empty>
            ) : (
              <div className="scroll-x">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Dimension</th>
                      <th>Unit</th>
                      <th>Nominal</th>
                      <th>Tol −</th>
                      <th>Tol +</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {dims[stage].map((row) => {
                      const p = stage.toLowerCase();
                      return (
                        <tr key={row.rowId}>
                          <td>
                            <input type="hidden" name={`${p}Key`} value={row.key} />
                            <input
                              className="input"
                              name={`${p}Name`}
                              value={row.name}
                              onChange={(e) => setDim(stage, row.rowId, { name: e.target.value })}
                              placeholder="Outside diameter"
                              required
                            />
                          </td>
                          <td>
                            <input
                              className="input ltr w-20"
                              name={`${p}Unit`}
                              value={row.unit ?? ""}
                              onChange={(e) => setDim(stage, row.rowId, { unit: e.target.value })}
                            />
                          </td>
                          {(["nominal", "tolMinus", "tolPlus"] as const).map((field) => (
                            <td key={field}>
                              <input
                                className="input num w-24"
                                type="number"
                                step="any"
                                name={`${p}${field[0].toUpperCase()}${field.slice(1)}`}
                                value={row[field] ?? ""}
                                onChange={(e) =>
                                  setDim(stage, row.rowId, {
                                    [field]: e.target.value === "" ? null : Number(e.target.value),
                                  })
                                }
                              />
                            </td>
                          ))}
                          <td>
                            <button
                              type="button"
                              className="btn"
                              onClick={() =>
                                setDims((all) => ({
                                  ...all,
                                  [stage]: all[stage].filter((r) => r.rowId !== row.rowId),
                                }))
                              }
                            >
                              ✕
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ))}

        <Card
          className="mt-4"
          title="Visual defects for this item"
          subtitle="On top of the shared list. Leave empty to use the shared list alone."
          action={
            <button
              type="button"
              className="btn"
              onClick={() =>
                setDefects((ds) => [...ds, { rowId: rowId(), key: "", name: "", department: null }])
              }
            >
              + Add
            </button>
          }
        >
          {defects.length === 0 ? (
            <Empty>None of its own.</Empty>
          ) : (
            <div className="grid gap-2">
              {defects.map((row) => (
                <div key={row.rowId} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                  <input type="hidden" name="defectKey" value={row.key} />
                  <input
                    className="input"
                    name="defectName"
                    value={row.name}
                    onChange={(e) =>
                      setDefects((ds) =>
                        ds.map((d) => (d.rowId === row.rowId ? { ...d, name: e.target.value } : d))
                      )
                    }
                    placeholder="Scratch"
                    required
                  />
                  <select
                    className="select"
                    name="defectDepartment"
                    value={row.department ?? ""}
                    onChange={(e) =>
                      setDefects((ds) =>
                        ds.map((d) =>
                          d.rowId === row.rowId ? { ...d, department: e.target.value || null } : d
                        )
                      )
                    }
                  >
                    <option value="">— Usually nobody&rsquo;s in particular —</option>
                    {departments.map((dep) => (
                      <option key={dep} value={dep}>{dep}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setDefects((ds) => ds.filter((d) => d.rowId !== row.rowId))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </ActionForm>

      <p className="mt-4 text-sm">
        <Link href="/settings/" className="font-bold text-[var(--brand)]">← All settings</Link>
      </p>
    </>
  );
}

function ItemPicker() {
  return <ItemEditor code={useSearchParams().get("code")} />;
}

export default function ItemPage() {
  return (
    <Suspense fallback={null}>
      <ItemPicker />
    </Suspense>
  );
}
