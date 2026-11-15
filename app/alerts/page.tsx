"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { State } from "@/components/ui";

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
  const describe = (a: any) => a.kind === "strategy_signal"
    ? `Signal from “${strategyName(a.strategy_id)}”${a.symbol ? ` on ${a.symbol}` : ""}`
    : `${a.symbol}: ${data.kinds[a.kind].toLowerCase()} ${a.value}${UNIT[a.kind] ? ` ${UNIT[a.kind]}` : ""}`;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Alerts</h1>
          <p className="sub">Be told when a stock reaches a level or a strategy gives a signal. Alerts are checked as prices update while the app is open.</p>
        </div>
      </div>
      {permission === "default" && (
        <div className="note info">
          Alerts appear inside the app. To also get a desktop notification when the tab is in the background:{" "}
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
        <p className="muted" style={{ fontSize: 12 }}>An alert fires at most once per trading day, then is ready again the next day. RSI and strategy signals are read on daily bars.</p>
      </div>

      <State loading={loading} error={error}>
        {data && (
          <>
            <div className="card section">
              <h2>Your alerts ({data.alerts.length})</h2>
              {data.alerts.length ? (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Alert</th><th className="l">Note</th><th>Last fired</th><th>Status</th><th>&nbsp;</th></tr></thead>
                    <tbody>
                      {data.alerts.map((a: any) => (
                        <tr key={a.id}>
                          <td className="wrap">{describe(a)}</td><td className="l wrap muted">{a.note}</td><td>{a.last_triggered_on ?? "never"}</td>
                          <td>{a.active ? <span className="badge ok">On</span> : <span className="badge">Off</span>}</td>
                          <td><button className="small" onClick={() => toggle(a)}>{a.active ? "Turn off" : "Turn on"}</button>{" "}
                            <button className="small danger" onClick={() => remove(a)}>Delete</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <div className="empty">No alerts yet.</div>}
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
              ) : <div className="empty">Nothing has fired yet.</div>}
            </div>
          </>
        )}
      </State>
    </>
  );
}
