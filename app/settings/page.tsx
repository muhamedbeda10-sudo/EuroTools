"use client";

import Link from "next/link";

import { ActionForm } from "@/components/ActionForm";
import { Async } from "@/components/Async";
import { ImportPanel } from "@/components/ImportPanel";
import { InlineForm } from "@/components/InlineForm";
import { Card, Empty, PageHeader } from "@/components/ui";
import { can } from "@/lib/domain/roles";
import { STAGES, STAGE_LABELS } from "@/lib/domain/workflow";
import { fmtDateTime } from "@/lib/format";
import {
  DEFECT_COLUMNS,
  DIMENSION_COLUMNS,
  parseDefects,
  parseDimensions,
  type DefectRow,
  type DimensionRow,
} from "@/lib/import/parse";
import { deleteItemConfig, importItemConfigs, saveDepartments } from "@/lib/client/actions";
import { getConfiguration } from "@/lib/client/queries";
import { useAsync } from "@/lib/client/use-async";
import { useRequireSession } from "@/lib/client/session";

/** What a piece has to be, set once instead of typed at every inspection.
 *
 *  Two things live here and they are not the same: the dimensions and defects
 *  for an item, which decide what the sheet asks for; and the department list,
 *  which decides what a hold may name. The second matters more than it looks:
 *  free-text departments turn "Machining", "machining" and "M/C shop" into
 *  three columns on the dashboard describing one place.
 */
export default function SettingsPage() {
  const me = useRequireSession();
  const state = useAsync(() => getConfiguration(), []);
  if (!me) return null;

  const mayManage = can(me.role, "config.manage");

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Dimensions, visual defects and departments — set here, used on every sheet"
      />

      {!mayManage && (
        <p className="mb-4 rounded-[var(--radius-sm)] bg-[var(--surface-2)] p-2.5 text-sm text-[var(--muted)]">
          You can read this, but changing what a piece has to be needs a quality manager.
        </p>
      )}

      <Async state={state}>
        {(c) => (
          <>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card
                title="Departments"
                subtitle="What a hold may be recorded against. One per line."
              >
                {mayManage ? (
                  <ActionForm
                    action={saveDepartments(me)}
                    onSuccess={state.refresh}
                    submitLabel="Save departments"
                  >
                    <textarea
                      className="textarea"
                      name="departments"
                      rows={6}
                      defaultValue={c.departments.join("\n")}
                      placeholder={"Machining\nGrinding\nHeat treatment\nAssembly"}
                    />
                  </ActionForm>
                ) : c.departments.length === 0 ? (
                  <Empty>No departments yet.</Empty>
                ) : (
                  <ul className="grid gap-1 text-sm">
                    {c.departments.map((d) => (
                      <li key={d}>• {d}</li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card
                title="Shared defect list"
                subtitle="Every item starts from these. An item may add its own on top."
              >
                {c.catalogue.length === 0 ? (
                  <Empty>
                    Nothing yet. Bring in a defects sheet below, or an inspector will have nothing
                    to tick.
                  </Empty>
                ) : (
                  <ul className="grid gap-1 text-sm">
                    {c.catalogue.map((d) => (
                      <li key={d.key} className="flex items-baseline justify-between gap-3">
                        <span>{d.name}</span>
                        <span className="text-xs text-[var(--muted)]">{d.department ?? "—"}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            {mayManage && (
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <Card title="Bring in dimensions">
                  <ImportPanel<DimensionRow>
                    title="One row per dimension, per item, per stage."
                    columns={DIMENSION_COLUMNS}
                    parse={parseDimensions}
                    commit={(rows) => importItemConfigs(me)(rows, [])}
                    onDone={state.refresh}
                    describe={(r) =>
                      `${r.itemCode} · ${STAGE_LABELS[r.stage]} · ${r.name} ${r.nominal ?? ""}`
                    }
                  />
                </Card>

                <Card title="Bring in visual defects">
                  <ImportPanel<DefectRow>
                    title="Leave Item blank for a defect every item should be checked for."
                    columns={DEFECT_COLUMNS}
                    parse={parseDefects}
                    commit={(rows) => importItemConfigs(me)([], rows)}
                    onDone={state.refresh}
                    describe={(r) => `${r.itemCode ?? "(all items)"} · ${r.name} · ${r.department ?? "—"}`}
                  />
                </Card>
              </div>
            )}

            <Card
              className="mt-4"
              title="Items"
              subtitle="What each sheet will ask for"
              action={
                mayManage ? (
                  <Link href="/settings/item/" className="btn btn-primary">
                    + New item
                  </Link>
                ) : undefined
              }
            >
              {c.items.length === 0 ? (
                <Empty>
                  No item is configured. Until one is, an inspector has to type every dimension by
                  hand.
                </Empty>
              ) : (
                <div className="scroll-x">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>Name</th>
                        {STAGES.map((s) => (
                          <th key={s}>{STAGE_LABELS[s]}</th>
                        ))}
                        <th>Defects</th>
                        <th>Changed</th>
                        {mayManage && <th />}
                      </tr>
                    </thead>
                    <tbody>
                      {c.items.map((item) => (
                        <tr key={item.id}>
                          <td className="ltr font-bold">
                            {mayManage ? (
                              <Link
                                href={`/settings/item/?code=${encodeURIComponent(item.itemCode)}`}
                                className="text-[var(--brand)]"
                              >
                                {item.itemCode}
                              </Link>
                            ) : (
                              item.itemCode
                            )}
                          </td>
                          <td>{item.itemName}</td>
                          {STAGES.map((s) => (
                            <td key={s} className="num">
                              {item.dimensions?.[s]?.length ?? 0}
                            </td>
                          ))}
                          <td className="num">{item.defects?.length ?? 0}</td>
                          <td className="num whitespace-nowrap">{fmtDateTime(item.updatedAt)}</td>
                          {mayManage && (
                            <td>
                              <InlineForm
                                action={deleteItemConfig(me)}
                                onSuccess={state.refresh}
                                submitLabel="Remove"
                                submitClassName="btn-danger"
                                confirm={`Remove the configuration for ${item.itemCode}? Sheets already signed keep their own copy and are unchanged.`}
                              >
                                <input type="hidden" name="itemCode" value={item.itemCode} />
                              </InlineForm>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </Async>
    </>
  );
}
