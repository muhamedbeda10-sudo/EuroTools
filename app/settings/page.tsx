"use client";

import Link from "next/link";
import { useState } from "react";

import { ActionForm } from "@/components/ActionForm";
import { Async } from "@/components/Async";
import { ImportPanel } from "@/components/ImportPanel";
import { InlineForm } from "@/components/InlineForm";
import { PasteGrid, emptyRow, type GridColumn, type GridRow } from "@/components/PasteGrid";
import {
  AlertIcon,
  BoxIcon,
  BuildingIcon,
  RulerIcon,
  UploadIcon,
} from "@/components/icons";
import { Card, Empty } from "@/components/ui";
import { allows } from "@/lib/domain/roles";
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
import { useRequireSession, type SessionUser } from "@/lib/client/session";

const DIMENSION_GRID: GridColumn[] = [
  { key: "item", label: "Item", width: 12, placeholder: "Core" },
  { key: "itemName", label: "Item name", width: 14 },
  { key: "stage", label: "Stage", options: ["Roughing", "Finish"] },
  { key: "dimension", label: "Dimension", width: 18, placeholder: "Outside diameter" },
  { key: "unit", label: "Unit", width: 6 },
  { key: "nominal", label: "Nominal", width: 8, numeric: true },
  { key: "tolMinus", label: "Tol −", width: 8, numeric: true },
  { key: "tolPlus", label: "Tol +", width: 8, numeric: true },
];
const DIMENSION_HEADERS = ["Item", "Item name", "Stage", "Dimension", "Unit", "Nominal", "Tol -", "Tol +"];

const DEFECT_GRID: GridColumn[] = [
  { key: "item", label: "Item", width: 12, placeholder: "blank = every item" },
  { key: "defect", label: "Defect", width: 18, placeholder: "Scratch" },
  { key: "department", label: "Department", width: 14 },
];
const DEFECT_HEADERS = ["Item", "Defect", "Department"];

export default function SettingsPage() {
  const me = useRequireSession();
  const state = useAsync(() => getConfiguration(), []);
  if (!me) return null;

  const mayManage = allows(me, "config.manage");

  return (
    <Async state={state}>
      {(c) => (
        <>
          {!mayManage && (
            <p className="mb-4 rounded-[var(--radius-sm)] bg-[var(--surface-2)] p-2.5 text-sm text-[var(--muted)]">
              You can read this. Changing what a piece has to be needs the permission for it.
            </p>
          )}

          {mayManage && (
            <>
              <Grid
                me={me}
                onSaved={state.refresh}
                icon={<RulerIcon />}
                title="Dimensions"
                subtitle="One row per dimension, per item, per stage. Paste a block straight out of Excel."
                columns={DIMENSION_GRID}
                headers={DIMENSION_HEADERS}
                parse={parseDimensions}
                commit={(me2, rows) => importItemConfigs(me2)(rows as DimensionRow[], [])}
                fileColumns={DIMENSION_COLUMNS}
                fileParse={parseDimensions}
                fileCommit={(me2, rows) => importItemConfigs(me2)(rows as DimensionRow[], [])}
                describe={(r) => `${r.itemCode} · ${STAGE_LABELS[r.stage]} · ${r.name}`}
              />

              <Grid
                me={me}
                onSaved={state.refresh}
                icon={<AlertIcon />}
                title="Visual defects"
                subtitle="Leave Item blank for a defect every item should be checked for."
                columns={DEFECT_GRID}
                headers={DEFECT_HEADERS}
                parse={parseDefects}
                commit={(me2, rows) => importItemConfigs(me2)([], rows as DefectRow[])}
                fileColumns={DEFECT_COLUMNS}
                fileParse={parseDefects}
                fileCommit={(me2, rows) => importItemConfigs(me2)([], rows as DefectRow[])}
                describe={(r) => `${r.itemCode ?? "(all items)"} · ${r.name}`}
              />
            </>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card
              className="rise"
              title={
                <span className="inline-flex items-center gap-2">
                  <BuildingIcon /> Departments
                </span>
              }
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
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    A list rather than free text on purpose: otherwise
                    &ldquo;Machining&rdquo;, &ldquo;machining&rdquo; and &ldquo;M/C shop&rdquo;
                    become three columns on the dashboard describing one place.
                  </p>
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
              className="rise"
              title={
                <span className="inline-flex items-center gap-2">
                  <AlertIcon /> Shared defect list
                </span>
              }
              subtitle="Every item starts from these"
            >
              {c.catalogue.length === 0 ? (
                <Empty>Nothing yet — an inspector would have nothing to tick.</Empty>
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

          <Card
            className="rise mt-4"
            title={
              <span className="inline-flex items-center gap-2">
                <BoxIcon /> Items
              </span>
            }
            subtitle="What each sheet will ask for"
            action={
              mayManage ? (
                <Link href="/settings/item/" className="btn btn-primary">
                  New item
                </Link>
              ) : undefined
            }
          >
            {c.items.length === 0 ? (
              <Empty>
                No item is configured. Until one is, an inspector types every dimension by hand.
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
                          <td key={s} className="num">{item.dimensions?.[s]?.length ?? 0}</td>
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
  );
}

/** A grid and a file picker side by side, both feeding one parser.
 *
 *  Whatever is typed here goes through exactly the same checks a file does, so
 *  there is no second, looser way in. What the parser objects to is shown
 *  against the row it objects to, before anything is written.
 */
function Grid<T>({
  me,
  onSaved,
  icon,
  title,
  subtitle,
  columns,
  headers,
  parse,
  commit,
  fileColumns,
  fileParse,
  fileCommit,
  describe,
}: {
  me: SessionUser;
  onSaved: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  columns: GridColumn[];
  headers: string[];
  parse: (grid: unknown[][]) => { rows: T[]; problems: { row: number; message: string }[] };
  commit: (me: SessionUser, rows: T[]) => Promise<{ ok: boolean; error?: string; info?: string }>;
  fileColumns: string[];
  fileParse: (grid: unknown[][]) => { rows: T[]; problems: { row: number; message: string }[] };
  fileCommit: (me: SessionUser, rows: T[]) => Promise<{ ok: boolean; error?: string; info?: string }>;
  describe: (row: T) => string;
}) {
  const [rows, setRows] = useState<GridRow[]>(() => [emptyRow(columns)]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const filled = rows.filter((r) => Object.values(r).some((v) => v.trim() !== ""));

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const parsed = parse([headers, ...filled.map((r) => columns.map((c) => r[c.key] ?? ""))]);
      if (parsed.problems.length > 0) {
        setMessage({
          tone: "bad",
          text: parsed.problems.slice(0, 4).map((p) => `Row ${p.row - 1}: ${p.message}`).join(" · "),
        });
        return;
      }
      const outcome = await commit(me, parsed.rows);
      setMessage({ tone: outcome.ok ? "ok" : "bad", text: outcome.info ?? outcome.error ?? "" });
      if (outcome.ok) {
        setRows([emptyRow(columns)]);
        onSaved();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 grid gap-4 xl:grid-cols-[2fr_1fr]">
      <Card
        className="rise"
        title={<span className="inline-flex items-center gap-2">{icon} {title}</span>}
        subtitle={subtitle}
      >
        <PasteGrid columns={columns} rows={rows} onChange={setRows} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || filled.length === 0}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : `Save ${filled.length || ""} row(s)`.replace("  ", " ")}
          </button>
          {message && (
            <span
              className={`text-sm ${
                message.tone === "ok" ? "text-[var(--ok-fg)]" : "text-[var(--bad-fg)]"
              }`}
            >
              {message.text}
            </span>
          )}
        </div>
      </Card>

      <Card
        className="rise"
        title={
          <span className="inline-flex items-center gap-2">
            <UploadIcon /> From a file
          </span>
        }
      >
        <ImportPanel<T>
          title={subtitle}
          columns={fileColumns}
          parse={fileParse}
          commit={(r) => fileCommit(me, r)}
          onDone={onSaved}
          describe={describe}
        />
      </Card>
    </div>
  );
}
