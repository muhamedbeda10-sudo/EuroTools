"use client";
import { Plus, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import StrategyForm, { blankStrategy, type Strategy } from "@/components/StrategyForm";
import { Empty, State } from "@/components/ui";

const FAMILY: Record<string, string> = { technical: "Technical", momentum: "Momentum", fundamental: "Fundamental", ai: "AI" };
const pctOrNone = (v: number | null | undefined, word: string) => (v == null ? `no ${word}` : `${word} ${v}%`);

export default function Strategies() {
  const types = useApi("/api/v1/strategy-types");
  const list = useApi("/api/v1/strategies");
  const sectors = useApi("/api/v1/market/sectors");
  const [draft, setDraft] = useState<Strategy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const { id, ...body } = draft;
    try {
      await api(id ? `/api/v1/strategies/${id}` : "/api/v1/strategies", { method: id ? "PUT" : "POST", json: body });
      setDraft(null);
      list.reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (s: any) => {
    if (!confirm(`Delete strategy "${s.name}"? Saved backtests are kept.`)) return;
    await api(`/api/v1/strategies/${s.id}`, { method: "DELETE" });
    list.reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Strategy Management</h1>
          <p className="sub">Create and configure strategies. Saving a strategy does not activate it: testing is a separate step in the Simulator.</p>
        </div>
        {!draft && <button className="primary" onClick={() => (setDraft(blankStrategy()), setError(null))}><Plus size={15} aria-hidden="true" />New strategy</button>}
      </div>

      {draft && types.data && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>{draft.id ? "Edit strategy" : "New strategy"}</h2>
          <StrategyForm value={draft} onChange={setDraft} types={types.data} sectors={(sectors.data ?? []).map((s: any) => s.sector)} />
          {error && <div className="note danger" role="alert">{error}</div>}
          <div className="form-actions">
            <button className="primary" disabled={busy || !draft.name.trim()} onClick={save}>{busy ? "Saving…" : "Save strategy"}</button>
            <button onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        <h2>Saved strategies{list.data?.length ? <span className="count"> {list.data.length}</span> : null}</h2>
        <State loading={list.loading} error={list.error}>
          {list.data &&
            (list.data.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th className="l">Type</th><th className="l">Rules</th><th className="l">Risk</th><th className="l">Applies to</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {list.data.map((s: any) => (
                      <tr key={s.id}>
                        <td><strong>{s.name}</strong><span className="sub2">{s.horizon.replace("_", " ")}</span></td>
                        <td className="l wrap" style={{ minWidth: 120 }}>{types.data?.[s.type]?.label ?? s.type}</td>
                        <td className="l wrap" style={{ minWidth: 120 }}>{Object.entries(s.params).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ") || <span className="muted">defaults</span>}</td>
                        <td className="l wrap" style={{ minWidth: 130 }}>{pctOrNone(s.risk.stop_loss_pct, "stop")} · {pctOrNone(s.risk.take_profit_pct, "target")}
                          <span className="sub2">{s.risk.max_alloc_pct}% per trade · max {s.risk.max_open_positions} positions</span></td>
                        <td className="l wrap" style={{ minWidth: 110 }}>{[...s.symbols, ...s.sectors].join(", ") || "All stocks"}</td>
                        <td className="actions">
                          <Link className="btn small primary" href={`/simulator?strategy=${s.id}`}>Backtest</Link>
                          <button className="small" onClick={() => (setDraft({ ...s }), setError(null), window.scrollTo({ top: 0 }))}>Edit</button>
                          <button className="small danger" onClick={() => remove(s)}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon={SlidersHorizontal} title="No strategies yet"
                action={!draft && <button className="primary" onClick={() => (setDraft(blankStrategy()), setError(null))}><Plus size={15} aria-hidden="true" />New strategy</button>}>
                A strategy is a set of entry and exit rules with risk limits. Save one, then test it in the Simulator.
              </Empty>
            ))}
        </State>
      </div>

      <div className="card section">
        <h2>Strategy library</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Family</th><th className="l">Type</th><th className="l">What it does</th><th className="l">Status</th></tr></thead>
            <tbody>
              {types.data && Object.entries(types.data).map(([k, t]: [string, any]) => (
                <tr key={k}>
                  <td><span className="badge">{FAMILY[t.family] ?? t.family}</span></td><td className="l"><strong>{t.label}</strong></td>
                  <td className="l wrap">{t.description}</td>
                  <td className="l wrap">{t.available ? <span className="badge ok">Available</span>
                    : <><span className="badge">Not yet</span><span className="sub2" style={{ marginTop: 4 }}>{t.unavailable_reason}</span></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
