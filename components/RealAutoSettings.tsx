"use client";
import { Lock } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { DATA_UPDATED, useApi } from "@/lib/useApi";
import { useStatus } from "@/components/Shell";
import { CardHead, State } from "@/components/ui";

type Draft = { budget: string; max_order_value: string; max_day_buys: string; max_day_value: string; max_loss: string; max_stop_pct: string; symbols: string };

const text = (v: unknown) => (v == null ? "" : String(Number(v)));

/** The owner's box for automatic orders: what may go to the broker without their approval of each order, and the switch for it. */
export default function RealAutoSettings() {
  const { data, loading, error, status, reload } = useApi("/api/v1/real-orders/auto");
  const [d, setD] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const background = !!useStatus()?.real_orders?.background;   // the server also takes looks by itself
  useEffect(() => {
    if (!data) return;
    const b = data.box;
    setD({ budget: text(b.budget), max_order_value: text(b.max_order_value), max_day_buys: text(b.max_day_buys), max_day_value: text(b.max_day_value), max_loss: text(b.max_loss),
           max_stop_pct: text(b.max_stop_pct), symbols: b.symbols.join(", ") });
  }, [data]);

  if (status === 403 || status === 404) return null;   // the card above already says whose this is

  const save = async (enabled: boolean) => {
    if (!d || !data) return;
    if (enabled && !data.box.enabled && !confirm(
      "Switch automatic orders on?\n\nFrom then on, during the session, an order the assistant proposes inside this box is sent to the broker " +
      "with real money WITHOUT asking you first. You can stop it at any moment from the Real account page.")) return;
    // An empty field means "not set". Anything else must be a number: text that is not one is refused here, never sent as "not set".
    const amount = (v: string) => (String(v).trim() === "" ? null : Number(v));
    const typed = [d.budget, d.max_order_value, d.max_day_buys, d.max_day_value, d.max_loss, d.max_stop_pct];
    if (typed.some((v) => String(v).trim() !== "" && !Number.isFinite(Number(v)))) {
      setMsg({ ok: false, text: "One of the amounts is not a number. Write digits only, such as 15000 or 15000.50." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      if (!enabled && data.box.enabled) await api("/api/v1/real-orders/auto/stop", { method: "POST" });   // also cancels its open buys
      await api("/api/v1/real-orders/auto", { method: "PUT", json: {
        enabled, budget: amount(d.budget), max_order_value: amount(d.max_order_value), max_day_buys: amount(d.max_day_buys), max_day_value: amount(d.max_day_value),
        max_loss: amount(d.max_loss), max_stop_pct: amount(d.max_stop_pct) ?? 8, symbols: d.symbols.split(/[\s,]+/).filter(Boolean),
      } });
      setMsg({ ok: true, text: enabled ? `Saved. Automatic orders are on: they run during the session${background ? ", with the app open or closed." : " while this app is open."}`
        : "Saved. Automatic orders are off: every order needs your approval." });
      reload();
      window.dispatchEvent(new Event(DATA_UPDATED));   // the top bar and the Real account page show the switch
    } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  const set = (patch: Partial<Draft>) => d && setD({ ...d, ...patch });
  const digits = (v: string) => v.replace(/[^\d.]/g, "");
  const proof = data?.proof;
  return (
    <div className="card">
      <CardHead title="Automatic orders">
        {data && <span className={`badge ${data.on ? "bad" : ""}`}>{data.on ? "automatic orders on" : !proof?.proven ? "locked" : "automatic orders off"}</span>}
      </CardHead>
      <State loading={loading} error={error}>
        {d && data && (
          <>
            <p className="muted" style={{ marginTop: 0, maxWidth: "95ch" }}>
              With this on, a real order the assistant proposes is sent to EFG Hermes <strong>without waiting for your approval</strong>, as long as it fits the
              box below. It passes every check an order you approve yourself passes, and anything outside the box simply waits for you on
              the <Link href="/account">Real account</Link> page as before. The app then watches what it bought and sells it at its stop-loss or take-profit.
            </p>
            {!proof.proven && (
              <div className="note" role="status">
                <strong><Lock size={13} aria-hidden="true" style={{ verticalAlign: "-2px" }} /> Locked until real orders have worked by hand.</strong>{" "}
                The switch opens after {proof.needed_sent} orders you approved yourself were accepted by the broker and at least {proof.needed_filled} of them
                filled. So far: <strong>{proof.sent} accepted, {proof.filled} filled</strong>. You can set the box now.
              </div>
            )}
            <div className="row" style={{ maxWidth: 860 }}>
              <div><label htmlFor="ra-budget">Budget (EGP)</label>
                <input id="ra-budget" inputMode="decimal" value={d.budget} onChange={(e) => set({ budget: digits(e.target.value) })} /></div>
              <div><label htmlFor="ra-order">Most for one automatic order (EGP)</label>
                <input id="ra-order" inputMode="decimal" value={d.max_order_value} onChange={(e) => set({ max_order_value: digits(e.target.value) })} /></div>
              <div><label htmlFor="ra-buys">Most automatic buys in one day</label>
                <input id="ra-buys" inputMode="numeric" value={d.max_day_buys} onChange={(e) => set({ max_day_buys: e.target.value.replace(/[^\d]/g, "") })} /></div>
              <div><label htmlFor="ra-dayvalue">Most it may buy in one day (EGP, optional)</label>
                <input id="ra-dayvalue" inputMode="decimal" value={d.max_day_value} placeholder="no extra ceiling" onChange={(e) => set({ max_day_value: digits(e.target.value) })} /></div>
              <div><label htmlFor="ra-loss">Stop buying for the day when down by (EGP)</label>
                <input id="ra-loss" inputMode="decimal" value={d.max_loss} onChange={(e) => set({ max_loss: digits(e.target.value) })} /></div>
              <div><label htmlFor="ra-stop">Stop-loss at most this % under the buying price</label>
                <input id="ra-stop" inputMode="decimal" value={d.max_stop_pct} onChange={(e) => set({ max_stop_pct: digits(e.target.value) })} /></div>
            </div>
            <div className="field" style={{ marginTop: 12, maxWidth: 860 }}>
              <label htmlFor="ra-symbols">The stocks it may trade (required, at most 20)</label>
              <input id="ra-symbols" value={d.symbols} placeholder="COMI, TMGH" onChange={(e) => set({ symbols: e.target.value.toUpperCase() })} />
            </div>
            <ul className="muted" style={{ fontSize: 12.5, maxWidth: "100ch", paddingLeft: 18, margin: "12px 0" }}>
              {background
                ? <li><strong>It runs during the session, with the app open or closed:</strong> you switched on running without the app open (below), so the server keeps looking once a minute. If that stops, nothing is sent or watched until the app is open again.</li>
                : <li><strong>It runs only while this app is open during the session.</strong> Close it, lock the phone or lose the connection, and nothing is sent and no stop-loss is watched until it is open again. To keep it going with the app closed, see “Running without the app open” below.</li>}
              <li>The budget is the most it may have in the market at once, at cost, counting its open buy orders. What it has lost so far comes off it, so the budget is also the most it can lose. Raise it to add more.</li>
              <li>Every automatic buy needs a stop-loss. The stop is watched by the app, not left at the broker: when the price reaches it, a sale is sent at the best bid price, inside your price band.</li>
              <li><strong>A stop cannot sell shares that have not settled.</strong> On EGX, shares bought today can usually be sold only two sessions later. Until the broker shows them as free to sell, the stop-loss on a fresh purchase cannot act; the app says so and sells as soon as it can.</li>
              <li>It sells only shares it bought itself. Everything else in your account is yours alone. A stock sold at its stop is not bought again by it the same day.</li>
              <li>Only what the assistant writes after you switch this on can go out by itself, and your own limits above still apply to every order.</li>
              <li>Switching it off stops everything at once, the watching of stop-losses included. Shares it bought stay in your account for you to manage.</li>
            </ul>
            <div className="form-actions">
              {data.box.enabled
                ? <><button className="primary" disabled={busy} onClick={() => save(true)}>Save box</button>
                    <button className="danger" disabled={busy} onClick={() => save(false)}>Switch automatic orders off</button></>
                : <><button disabled={busy} onClick={() => save(false)}>Save box</button>
                    <button className="primary" disabled={busy || !proof.proven} title={proof.proven ? undefined : "Locked until orders you approved yourself have worked"}
                      onClick={() => save(true)}>Save and switch automatic orders on</button></>}
            </div>
            {data.box.enabled && !data.on && data.why_not && <div className="note" style={{ marginTop: 12 }}>It is switched on but not running: {data.why_not}</div>}
            {msg && <div className={`note ${msg.ok ? "info" : "danger"}`} role={msg.ok ? "status" : "alert"} style={{ marginTop: 12 }}>{msg.text}</div>}
          </>
        )}
      </State>
    </div>
  );
}
