"use client";
import { Bell, BellRing } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Empty, State } from "@/components/ui";

const UNIT: Record<string, string> = { price_above: "EGP", price_below: "EGP", change_pct_above: "%", change_pct_below: "%", volume_ratio_above: "× average", rsi_above: "", rsi_below: "" };
const blank = () => ({ kind: "price_above", symbol: "", value: "", strategy_id: "", note: "", active: true });

export default function Alerts() {
  const { data, loading, error, reload } = useApi("/api/v1/alerts");
  const strategies = useApi("/api/v1/strategies");
  const [draft, setDraft] = useState<any>(blank());
  const [formError, setFormError] = useState<string | null>(null);
  // Read in an effect: the pre-rendered page has no browser to ask.
  const [permission, setPermission] = useState<string>("unsupported");
  useEffect(() => { if (typeof Notification !== "undefined") setPermission(Notification.permission); }, []);
  const isSignal = draft.kind === "strategy_signal";

  const body = (a: any) => ({ kind: a.kind, symbol: a.symbol || null, value: a.kind === "strategy_signal" ? null : Number(a.value),
    strategy_id: a.kind === "strategy_signal" ? a.strategy_id || null : null, note: a.note ?? "", active: a.active });
  const save = async () => {
    setFormError(null);
    try {
      await api("/api/v1/alerts", { method: "POST", json: body(draft) });
      setDraft(blank());
      reload();
    } catch (e: any) { setFormError(e.message); }
  };
  const toggle = async (a: any) => { await api(`/api/v1/alerts/${a.id}`, { method: "PUT", json: body({ ...a, active: !a.active }) }); reload(); };
  const remove = async (a: any) => { await api(`/api/v1/alerts/${a.id}`, { method: "DELETE" }); reload(); };
  const strategyName = (id: string) => strategies.data?.find((s: any) => s.id === id)?.name ?? "deleted strategy";
  /** The condition in plain words, e.g. "Price falls to or below EGP 100". */
  const condition = (a: any) => {
    const v = Number(a.value).toLocaleString("en-US", { maximumFractionDigits: 4 });
    switch (a.kind) {
      case "strategy_signal": return `Signal from “${strategyName(a.strategy_id)}”`;
      case "price_above": return `Price rises to or above EGP ${v}`;
      case "price_below": return `Price falls to or below EGP ${v}`;
      case "change_pct_above": return `Day change is at or above ${a.value > 0 ? "+" : ""}${v}%`;
      case "change_pct_below": return `Day change is at or below ${a.value > 0 ? "+" : ""}${v}%`;
      case "volume_ratio_above": return `Volume is at least ${v}× its 20-session average`;
      case "rsi_above": return `RSI (14) is at or above ${v}`;
      case "rsi_below": return `RSI (14) is at or below ${v}`;
      default: return `${data?.kinds?.[a.kind] ?? a.kind} ${v}`;
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alerts</h1>
          <p className="sub">Be told when a stock reaches a level or a strategy gives a signal. Alerts are checked as prices update while the app is open.</p>
        </div>
      </div>
      {permission === "default" && (
        <div className="note info" style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <span>Alerts appear inside the app. Allow notifications to also be told when the tab is in the background.</span>
          <button className="small" onClick={async () => setPermission(await Notification.requestPermission())}>Allow notifications</button>
        </div>
      )}
      {permission === "denied" && <div className="note">Desktop notifications are blocked in this browser; alerts will still show inside the app.</div>}

      <div className="card">
        <h2>New alert</h2>
        <div className="row">
          <div className="field" style={{ flex: "2 1 240px" }}><label htmlFor="a-kind">Tell me when</label>
            <select id="a-kind" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
              {data && Object.entries(data.kinds).map(([k, v]) => <option key={k} value={k}>{v as string}</option>)}
            </select></div>
          {isSignal ? (
            <div className="field"><label htmlFor="a-str">Strategy</label>
              <select id="a-str" value={draft.strategy_id} onChange={(e) => setDraft({ ...draft, strategy_id: e.target.value })}>
                <option value="">Select…</option>{(strategies.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select></div>
          ) : (
            <div className="field"><label htmlFor="a-val">Level{UNIT[draft.kind] ? ` (${UNIT[draft.kind]})` : ""}</label>
              <input id="a-val" type="number" step="any" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} /></div>
          )}
          <div className="field"><label htmlFor="a-sym">Stock{isSignal ? " (blank = any)" : ""}</label>
            <input id="a-sym" maxLength={12} value={draft.symbol} onChange={(e) => setDraft({ ...draft, symbol: e.target.value.toUpperCase() })} placeholder="COMI" /></div>
          <div className="field" style={{ flex: "2 1 200px" }}><label htmlFor="a-note">Note to yourself</label>
            <input id="a-note" maxLength={300} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></div>
          <button className="primary fit" onClick={save} disabled={isSignal ? !draft.strategy_id : !draft.symbol || draft.value === ""}>Add alert</button>
        </div>
        {formError && <div className="note danger" role="alert">{formError}</div>}
        <p className="foot-note" style={{ marginTop: 2 }}>An alert fires at most once per trading day, then is ready again the next day. RSI and strategy signals are read on daily bars.</p>
      </div>

      <State loading={loading} error={error}>
        {data && (
          <>
            <div className="card section">
              <h2>Your alerts<span className="count"> {data.alerts.length}</span></h2>
              {data.alerts.length ? (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Stock</th><th className="l">Condition</th><th className="l">Note</th><th className="l">Last fired</th><th className="l">Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      {data.alerts.map((a: any) => (
                        <tr key={a.id}>
                          <td>{a.symbol ? <Link href={`/stock?symbol=${a.symbol}`}><strong>{a.symbol}</strong></Link> : <span className="muted">Any stock</span>}</td>
                          <td className="l wrap">{condition(a)}</td><td className="l wrap muted">{a.note || "—"}</td>
                          <td className="l">{a.last_triggered_on ?? <span className="muted">Never</span>}</td>
                          <td className="l">{a.active ? <span className="badge ok"><span className="dot" />On</span> : <span className="badge">Off</span>}</td>
                          <td className="actions"><button className="small" onClick={() => toggle(a)}>{a.active ? "Turn off" : "Turn on"}</button>
                            <button className="small danger" onClick={() => remove(a)}>Delete</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <Empty icon={Bell} title="No alerts yet">Set a price level, a day move, a volume surge, an RSI level or a strategy signal above.</Empty>}
            </div>
            <div className="card section">
              <h2>Recently fired</h2>
              {data.events.length ? (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>When (UTC)</th><th className="l">What happened</th><th className="l">Note</th></tr></thead>
                    <tbody>
                      {data.events.map((e: any) => (
                        <tr key={e.seq}><td>{e.ts.slice(0, 16).replace("T", " ")}</td>
                          <td className="l wrap">{e.symbol ? <Link href={`/stock?symbol=${e.symbol}`}>{e.message}</Link> : e.message}</td>
                          <td className="l wrap muted">{e.note}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <Empty icon={BellRing} title="Nothing has fired yet">When a condition is met it is listed here and shown as a notice in the app.</Empty>}
            </div>
          </>
        )}
      </State>
    </>
  );
}
