"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { DATA_UPDATED, useApi } from "@/lib/useApi";
import { CardHead, State } from "@/components/ui";

type Draft = { enabled: boolean; max_order_value: string; max_day_value: string; max_day_orders: string; price_band_pct: string; symbols: string };

const text = (v: unknown) => (v == null ? "" : String(Number(v)));

/** The owner's own switch and limits for real orders. Nothing can be sent until all of it is set here. */
export default function RealTradingSettings() {
  const { data, loading, error, status, reload } = useApi("/api/v1/real-orders/settings");
  const [d, setD] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!data) return;
    const l = data.limits;
    setD({ enabled: l.enabled, max_order_value: text(l.max_order_value), max_day_value: text(l.max_day_value), max_day_orders: text(l.max_day_orders),
           price_band_pct: text(l.price_band_pct), symbols: l.symbols.join(", ") });
  }, [data]);

  if (status === 403 || status === 404)
    return <div className="card"><h2>Real trading</h2><p className="muted" style={{ margin: 0 }}>Real orders exist only for the owner of the brokerage account, on their own sign-in.</p></div>;

  const save = async (enabled: boolean) => {
    if (!d) return;
    if (enabled && !d.enabled && !confirm("Switch real orders on? From then on, an order you approve on the Real account page is sent to the broker with real money.")) return;
    setBusy(true);
    setMsg(null);
    const amount = (v: string) => (v.trim() === "" ? null : Number(v));
    try {
      await api("/api/v1/real-orders/settings", { method: "PUT", json: {
        enabled, max_order_value: amount(d.max_order_value), max_day_value: amount(d.max_day_value), max_day_orders: amount(d.max_day_orders),
        price_band_pct: amount(d.price_band_pct) ?? 2, symbols: d.symbols.split(/[\s,]+/).filter(Boolean),
      } });
      setMsg({ ok: true, text: enabled ? "Saved. Real orders are on: each one still needs your approval on the Real account page." : "Saved. Real orders are off: nothing can be sent." });
      reload();
      window.dispatchEvent(new Event(DATA_UPDATED));   // the menu and the top bar show the switch
    } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const set = (patch: Partial<Draft>) => d && setD({ ...d, ...patch });
  return (
    <div className="card">
      <CardHead title="Real trading">
        {data && <span className={`badge ${data.ready ? "warn" : ""}`}>{data.ready ? "real orders on" : "real orders off"}</span>}
      </CardHead>
      <State loading={loading} error={error}>
        {d && data && (
          <>
            <p className="muted" style={{ marginTop: 0, maxWidth: "95ch" }}>
              With this on, an order prepared on the <Link href="/account">Real account</Link> page, by you or by the assistant, can be sent to EFG Hermes
              once you approve it there. Every order is a limit order for the day, checked against these limits and against the broker&apos;s own
              figures at the moment you approve it. Nothing is ever sent without your approval of that order.
            </p>
            {!data.server_on && <div className="note"><strong>Switched off on the server.</strong> Real orders also need <code>LIVE_TRADING_ENABLED</code> to be set there. You can write your limits now; nothing can be sent until then.</div>}
            <div className="row" style={{ maxWidth: 860 }}>
              <div><label htmlFor="rt-order">Most for one order (EGP)</label>
                <input id="rt-order" inputMode="decimal" value={d.max_order_value} onChange={(e) => set({ max_order_value: e.target.value.replace(/[^\d.]/g, "") })} /></div>
              <div><label htmlFor="rt-day">Most in one day (EGP)</label>
                <input id="rt-day" inputMode="decimal" value={d.max_day_value} onChange={(e) => set({ max_day_value: e.target.value.replace(/[^\d.]/g, "") })} /></div>
              <div><label htmlFor="rt-count">Most orders in one day</label>
                <input id="rt-count" inputMode="numeric" value={d.max_day_orders} onChange={(e) => set({ max_day_orders: e.target.value.replace(/[^\d]/g, "") })} /></div>
              <div><label htmlFor="rt-band">Price at most this % past the market</label>
                <input id="rt-band" inputMode="decimal" value={d.price_band_pct} onChange={(e) => set({ price_band_pct: e.target.value.replace(/[^\d.]/g, "") })} /></div>
            </div>
            <div className="field" style={{ marginTop: 12, maxWidth: 860 }}>
              <label htmlFor="rt-symbols">Only these stocks (optional; leave empty for any listed stock)</label>
              <input id="rt-symbols" value={d.symbols} placeholder="COMI, TMGH" onChange={(e) => set({ symbols: e.target.value.toUpperCase() })} />
            </div>
            <ul className="muted" style={{ fontSize: 12.5, maxWidth: "100ch", paddingLeft: 18, margin: "12px 0" }}>
              <li>The three limits must be set before real orders can be switched on. They count orders that were sent, filled or not.</li>
              <li>“Past the market”: a buy may be priced at most this far above the market price, a sell at most this far below it. An order on the other side simply waits.</li>
              <li>Switching off stops every new order at once. An order already at the broker stays there; it can still be cancelled from the Real account page.</li>
            </ul>
            <div className="form-actions">
              {d.enabled
                ? <><button className="primary" disabled={busy} onClick={() => save(true)}>Save limits</button>
                    <button className="danger" disabled={busy} onClick={() => save(false)}>Switch real orders off</button></>
                : <><button disabled={busy} onClick={() => save(false)}>Save limits</button>
                    <button className="primary" disabled={busy} onClick={() => save(true)}>Save and switch real orders on</button></>}
            </div>
            {msg && <div className={`note ${msg.ok ? "info" : "danger"}`} role={msg.ok ? "status" : "alert"} style={{ marginTop: 12 }}>{msg.text}</div>}
          </>
        )}
      </State>
    </div>
  );
}
