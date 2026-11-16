"use client";
import { OctagonX } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { egp, int, num, price, tone } from "@/lib/format";
import { AWAKE_KEY, REAL_AUTO_AWAKE, REAL_AUTO_LOOK } from "@/lib/realAuto";
import { DATA_UPDATED, useApi } from "@/lib/useApi";
import { useStatus } from "@/components/Shell";

const hhmmss = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Africa/Cairo" });

/** One position the automation holds, with the levels it is watched by. The owner can move them. */
function Position({ p, watched, onSaved }: { p: any; watched: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState<{ stop: string; target: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!edit) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v1/real-orders/auto/positions/${p.symbol}`, { method: "PUT",
        json: { stop_price: Number(edit.stop), target_price: edit.target.trim() === "" ? null : Number(edit.target) } });
      setEdit(null);
      onSaved();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const digits = (v: string) => v.replace(/[^\d.]/g, "");
  return (
    <tr>
      <td>
        <div className="sym"><Link href={`/stock?symbol=${p.symbol}`}>{p.symbol}</Link><span title={p.name} dir="auto">{p.name}</span>
          {p.gave_up ? <span className="badge bad" title="Several sales did not complete today. Sell it yourself below.">sell it yourself</span>
            : p.selling ? <span className="badge warn">being sold</span>
            : p.at_stop ? <span className="badge warn">at its stop</span>
            : !watched ? <span className="badge" title="Automatic orders are not running, so nothing watches this position">not watched</span>
            : !p.live ? <span className="badge warn" title="No fresh live price: its stop-loss cannot be acted on right now">no live price</span>
            : <span className="badge ok">watched</span>}
          {/* on a narrow screen the level columns scroll out of view: the stop is said here too */}
          {!edit && <span className="narrow-levels num">stop {price(p.stop)}{p.target == null ? "" : ` · target ${price(p.target)}`}</span>}
        </div>
      </td>
      <td>{int(p.qty)}</td>
      <td>{price(p.last)}</td>
      {edit ? (
        <td colSpan={2} className="l">
          <div className="levels-edit">
            <label>Stop-loss <input inputMode="decimal" value={edit.stop} aria-label={`Stop-loss for ${p.symbol}`} onChange={(e) => setEdit({ ...edit, stop: digits(e.target.value) })} /></label>
            <label>Take-profit <input inputMode="decimal" value={edit.target} placeholder="none" aria-label={`Take-profit for ${p.symbol}`} onChange={(e) => setEdit({ ...edit, target: digits(e.target.value) })} /></label>
          </div>
          {error && <small className="sub2" style={{ color: "var(--down)" }} role="alert">{error}</small>}
          {Number(edit.stop) >= (p.last ?? Infinity) && <small className="sub2">At or above the price now: it would be sold at the next look.</small>}
        </td>
      ) : (
        <>
          <td>{price(p.stop)}</td>
          <td>{p.target == null ? <span className="muted">none</span> : price(p.target)}</td>
        </>
      )}
      <td>{price(p.avg_cost)}</td>
      <td className={tone(p.result)}>{num(p.result)}</td>
      <td className="actions">
        {edit ? <><button type="button" className="small primary" disabled={busy || !(Number(edit.stop) > 0)} onClick={save}>Save</button>
                  <button type="button" className="small" disabled={busy} onClick={() => { setEdit(null); setError(null); }}>Cancel</button></>
          : <button type="button" className="small" onClick={() => setEdit({ stop: p.stop == null ? "" : String(p.stop), target: p.target == null ? "" : String(p.target) })}>Move levels</button>}
      </td>
    </tr>
  );
}

/** Automatic orders on the Real account page: whether it is running, its budget, what it holds, and the one-tap stop. */
export default function RealAuto({ auto, reload, onChanged }: { auto: any; reload: () => void; onChanged: () => void }) {
  const [look, setLook] = useState<{ at: number; result: any } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [stopNotes, setStopNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [awake, setAwake] = useState(false);
  const [canWake, setCanWake] = useState(false);
  // Whether the server also takes looks by itself, and when it last did.
  const background = !!useStatus()?.real_orders?.background;
  const { data: bg, reload: reloadBg } = useApi(background ? "/api/v1/background" : null);
  useEffect(() => {
    setCanWake("wakeLock" in navigator);
    try { setAwake(localStorage.getItem(AWAKE_KEY) === "1"); } catch {}
    const onLook = (e: Event) => { setLook((e as CustomEvent).detail); reload(); reloadBg(); };
    window.addEventListener(REAL_AUTO_LOOK, onLook);
    return () => window.removeEventListener(REAL_AUTO_LOOK, onLook);
  }, [reload, reloadBg]);

  if (!auto || !(auto.box.enabled || auto.positions.length > 0)) return null;
  const b = auto.budget;
  const stop = async () => {
    if (!confirm("Stop automatic orders now?\n\nNo further order is sent by itself, its buy orders still open at the broker are cancelled, and stop-losses are no longer watched. " +
                 "Shares it bought stay in your account for you to manage.")) return;
    setBusy(true);
    setFailed(null);
    try {
      const out = await api("/api/v1/real-orders/auto/stop", { method: "POST" });
      setStopNotes(out.stop_notes ?? []);
    } catch (e: any) { setFailed(e.message); } finally { setBusy(false); }
    reload();
    onChanged();
    window.dispatchEvent(new Event(DATA_UPDATED));
  };
  const keepAwake = (on: boolean) => {
    setAwake(on);
    try { localStorage.setItem(AWAKE_KEY, on ? "1" : "0"); } catch {}
    window.dispatchEvent(new Event(REAL_AUTO_AWAKE));
  };
  const notes: string[] = auto.on && look?.result?.ran ? look.result.notes ?? [] : [];
  return (
    <div className="card section auto-card">
      <div className="card-head">
        <h2>Automatic orders</h2>
        <span className={`badge ${auto.on ? "bad" : ""}`}>{auto.on ? (auto.paused ? "on · not buying today" : "on") : "off"}</span>
        {auto.box.enabled && (
          <button type="button" className="danger stop-auto" disabled={busy} onClick={stop}><OctagonX size={15} aria-hidden="true" /> {busy ? "Stopping…" : "Stop automatic orders"}</button>
        )}
      </div>
      {auto.on ? (
        <p className="muted" style={{ marginTop: 0, fontSize: 12.5 }} role="status">
          {auto.market_open
            ? <>{background ? "Running with the app open or closed" : "Running while this app is open"}: the assistant&apos;s proposals that fit your box are sent without asking you, and the positions below are watched.{" "}
                {look ? <span className="num">Last look {hhmmss(look.at)}{look.result?.ran || look.result?.busy ? "" : ` · ${String(look.result?.why ?? "it did not run").replace(/\.$/, "")}`}.</span> : "Waiting for the first look…"}</>
            : `The market is closed. It runs during the session, ${background ? "with the app open or closed" : "while this app is open"}.`}
          {background && bg?.beat?.at && <span className="num"> Last background look {hhmmss(Date.parse(bg.beat.at))}.</span>}
          {" "}<Link href="/settings?tab=real">Change the box</Link>
        </p>
      ) : auto.box.enabled ? (
        <div className="note" role="status">Switched on, but not running: {auto.why_not}</div>
      ) : (
        <div className="note" role="status">
          <strong>Automatic orders are off.</strong> The shares below were bought by the automation and are <strong>no longer watched</strong>: their
          stop-losses do nothing until it is switched on again in <Link href="/settings?tab=real">Settings</Link>. They are yours to manage.
        </div>
      )}
      {background && bg?.silent && auto.on && (
        <div className="note danger" role="alert"><strong>The server has not looked for several minutes.</strong> Background running is switched on, but nothing is being
          sent or watched with the app closed right now. Keep this app open, and check <Link href="/settings?tab=real">Running without the app open</Link>.</div>
      )}
      {auto.paused && <div className="note" role="status"><strong>Not buying for the rest of today:</strong> {auto.paused.why} It still sells at stop-losses and take-profits.</div>}
      {failed && <div className="note danger" role="alert">{failed}</div>}
      {stopNotes.length > 0 && <div className="note info" role="status"><ul>{stopNotes.map((n) => <li key={n}>{n}</li>)}</ul></div>}
      {notes.length > 0 && (
        <div className="note" role="status"><strong>From the last look ({hhmmss(look!.at)}):</strong><ul>{notes.map((n) => <li key={n} dir="auto">{n}</li>)}</ul></div>
      )}

      {b.limit != null && (
        <dl className="auto-figures">
          <div><dt>In the market</dt><dd>{egp(b.used)}</dd></div>
          <div><dt>Free of the budget</dt><dd>{egp(b.free)}</dd></div>
          <div><dt>Budget</dt><dd>{egp(b.limit)}{b.lost > 0 ? <small className="muted">{num(b.lost)} of it lost so far</small> : null}</dd></div>
          <div><dt>Automatic buys today</dt><dd>{int(auto.today.buys)} of {int(auto.box.max_day_buys)}</dd></div>
          <div><dt>Today, sales and open positions</dt><dd className={tone(auto.today.result)}>{egp(auto.today.result)}</dd></div>
        </dl>
      )}

      {auto.positions.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Shares the automation bought and still holds</caption>
            <thead><tr><th>Bought by it</th><th>Shares</th><th>Last</th><th>Stop-loss</th><th>Take-profit</th><th>Avg cost</th><th>Result</th>
              <th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{auto.positions.map((p: any) => <Position key={p.symbol} p={p} watched={auto.on && auto.market_open} onSaved={reload} />)}</tbody>
          </table>
        </div>
      ) : (
        <p className="muted" style={{ fontSize: 13, margin: "10px 0 0" }}>The automation holds no shares right now.</p>
      )}
      {auto.on && canWake && !background && (
        <label className="check" style={{ marginTop: 12 }}>
          <input type="checkbox" checked={awake} onChange={(e) => keepAwake(e.target.checked)} />
          <span>Keep this screen on while automatic orders are running <span className="muted">(for a phone left open on its charger)</span></span>
        </label>
      )}
      <p className="foot-note">
        Stop-losses and take-profits are watched by this app, not left at the broker: they work during the session, {background
          ? "from the open app or from the server's own looks once a minute,"
          : "only while the app is open,"} and only for shares the broker shows as free to sell. Figures are before the broker&apos;s fees. The rest of your account is never touched by it.
      </p>
    </div>
  );
}
