"use client";
import { CircleCheck, ClipboardCheck, Send, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { egp, int, num, price } from "@/lib/format";
import { DATA_UPDATED, useApi } from "@/lib/useApi";
import { Empty } from "@/components/ui";

const RECHECK_MS = 30 * 1000;      // while something is open at the broker or waits for a decision
const QUIET_MS = 20 * 1000;        // the least time between two re-reads set off by other screens

const sideWord = (side: string) => (side === "BUY" ? "Buy" : "Sell");
const SideBadge = ({ side }: { side: string }) => <span className={`badge ${side === "BUY" ? "ok" : "bad"}`}>{side}</span>;
/** Who wrote an order down, and whether it went out on the owner's yes or by itself. */
const from = (o: any) => (o.origin === "automation" ? "the app, at a stop or target" : o.origin === "assistant" ? "assistant" : "you")
  + (o.approved_by === "auto" && o.origin !== "automation" ? ", sent automatically" : "");
const levels = (o: any) => (o.stop == null && o.target == null ? null
  : <span className="muted"> · stop-loss {o.stop == null ? "none" : price(o.stop)}{o.target == null ? "" : ` · take-profit ${price(o.target)}`}</span>);
const clock = (stamp?: string | null) => (stamp ? new Date(stamp).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Cairo" }) : "—");

/** What became of an order, in a few words: the app's own state first, then the broker's. */
function Outcome({ o }: { o: any }) {
  const b = o.broker;
  const [tone, text] =
    o.status === "sent" ? (
      b?.state === "filled" ? ["ok", "Filled"] : b?.state === "partial" ? ["warn", "Partly filled, still open"]
        : b?.state === "cancelled" ? ["", b.executed_qty > 0 ? "Cancelled, partly filled" : "Cancelled"]
        : b?.state === "rejected" ? ["bad", "Rejected by the exchange"]
        : b?.state === "expired" || b?.state === "ended" ? ["", b.executed_qty > 0 ? "Ended, partly filled" : "Ended unfilled"]
        : ["paper", "Open at the broker"])
      : o.status === "rejected" ? ["bad", "Refused by the broker"]
      : o.status === "failed" ? ["", "Not sent"]
      : o.in_doubt ? ["warn", o.status === "sending" ? "Being sent" : "In doubt"]
      : o.status === "not_placed" ? ["", "Not placed"]
      : [ "", o.status === "declined" ? "Declined" : o.status === "withdrawn" ? "Withdrawn by the assistant" : o.status === "expired" ? "Expired undecided" : o.status];
  return (
    <div className="cell2" style={{ alignItems: "flex-start" }}>
      <span className={`badge ${tone}`}>{text}</span>
      {b?.status && <small className="muted" title="The broker's own word for it">broker: {b.status}</small>}
    </div>
  );
}

/** The last look before a real order goes out, then the outcome. Nothing is sent until the button here is pressed. */
function Review({ id, onClose }: { id: string; onClose: (changed: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [look, setLook] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    dialog.current?.showModal();
    let live = true;
    api(`/api/v1/real-orders/${id}/check`, { method: "POST" })
      .then((d) => live && setLook(d))
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [id]);

  const o = look?.order;
  const f = look?.facts ?? {};
  const send = async () => {
    if (busy || !o) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api(`/api/v1/real-orders/${id}/approve`, { method: "POST", json: { symbol: o.symbol, side: o.side, qty: o.qty, price: o.price } }));
    } catch (e: any) {
      setError(e.status === 409 ? "This changed while you were looking at it, or another approval went through at the same moment. Nothing was sent. Close this and look again." : e.message);
    } finally {
      setBusy(false);
    }
  };
  const close = () => { dialog.current?.close(); };
  return createPortal(
    <dialog ref={dialog} className="sheet" aria-labelledby="review-title" onClose={() => onClose(!!result)}
      onCancel={(e) => { if (busy) e.preventDefault(); }}>{/* Escape does not close it while the order is on its way: the answer must be seen */}
      <h2 id="review-title">{result ? "What the broker answered" : "Send this real order?"}</h2>
      {!look && !error && <p className="muted" aria-busy="true">Checking it against the broker&apos;s figures…</p>}
      {o && (
        <>
          <p className="order-line"><SideBadge side={o.side} /> {int(o.qty)} {o.symbol} <span className="muted">at</span> {price(o.price)}</p>
          <p className="muted" dir="auto">{o.name}{o.origin === "assistant" ? " · proposed by the assistant" : ""}{levels(o)}</p>
          {o.reason && <p className="why" dir="auto">{o.reason}</p>}
        </>
      )}
      {result ? (
        <>
          {result.status === "sent" && (
            <div className="note info" role="status"><strong>Sent.</strong> The broker took the order (number {result.broker?.order_id})
              {result.broker?.status ? ` and reports it as “${result.broker.status}”.` : "."} It is a day order: it ends unfilled at today&apos;s close.</div>
          )}
          {result.status === "rejected" && <div className="note danger" role="alert"><strong>The broker refused it.</strong> Nothing was placed. {result.status_note}</div>}
          {result.status === "failed" && <div className="note danger" role="alert"><strong>It was not sent.</strong> {result.status_note}</div>}
          {result.in_doubt && (
            <div className="note danger" role="alert"><strong>No clear answer came back.</strong> The order may or may not have been placed, and it has not been
              sent again. Look at your orders in the EFG Hermes ONE app; the list below will also look for it.</div>
          )}
          <div className="form-actions"><button type="button" className="primary" onClick={close}>Done</button></div>
        </>
      ) : (
        <>
          {o && look && (
            <dl className="kv ruled" style={{ margin: "14px 0" }}>
              <dt>Order value</dt><dd>{egp(f.value)}</dd>
              <dt>Fees, estimated{f.fees_verified ? "" : " (placeholder schedule)"}</dt><dd>{egp(f.est_fees)}</dd>
              {o.side === "BUY"
                ? <><dt>The broker says you can spend</dt><dd>{egp(f.buying_power)}</dd></>
                : <><dt>Free to sell</dt><dd>{f.held ? `${int(f.held.free)} of ${int(f.held.qty)}` : "—"}</dd></>}
              <dt>Market price now</dt><dd>{price(f.reference_price)}</dd>
              {f.distance_pct != null && <><dt>Your price against it</dt>
                <dd>{Math.abs(f.distance_pct) < 0.005 ? "at the market" : `${num(Math.abs(f.distance_pct))}% ${f.distance_pct > 0 ? "above" : "below"}`}</dd></>}
              {(f.min_price || f.max_price) && <><dt>The exchange accepts today</dt><dd>{price(f.min_price)} – {price(f.max_price)}</dd></>}
              {f.limits && (
                <>
                  <dt>Orders sent today, before this one</dt><dd>{int(f.day?.orders)} of {int(f.limits.max_day_orders)}</dd>
                  <dt>Their value, of your limit for a day</dt><dd>{num(f.day?.value)} of {num(Number(f.limits.max_day_value))}</dd>
                </>
              )}
            </dl>
          )}
          {look?.problems?.length > 0 && (
            <div className="note danger" role="alert"><strong>It cannot be sent:</strong><ul>{look.problems.map((p: string) => <li key={p}>{p}</li>)}</ul></div>
          )}
          {look?.notes?.length > 0 && <div className="note info"><ul>{look.notes.map((n: string) => <li key={n}>{n}</li>)}</ul></div>}
          {error && <div className="note danger" role="alert">{error}</div>}
          {look?.ok && <p className="foot-note"><strong>This is real money.</strong> The order goes to EFG Hermes as a limit order for today. Once sent it can only be cancelled while it is still open.</p>}
          <div className="form-actions">
            <button type="button" onClick={close} disabled={busy}>Not now</button>
            <button type="button" className="primary" onClick={send} disabled={busy || !look?.ok}>
              <Send size={14} aria-hidden="true" /> {busy ? "Sending…" : o ? `Send ${sideWord(o.side).toLowerCase()} order to the broker` : "Send to the broker"}
            </button>
          </div>
        </>
      )}
    </dialog>,
    document.body,
  );
}

/** Write a real order down for approval. It is checked as it is typed; nothing is sent from here. */
function Ticket({ start, holdings, onMade }: { start?: { symbol?: string; side?: string }; holdings: any[]; onMade: (id: string) => void }) {
  const [f, setF] = useState({ symbol: start?.symbol ?? "", side: start?.side === "SELL" ? "SELL" : "BUY", qty: "", price: "", reason: "" });
  const [look, setLook] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = { symbol: f.symbol.trim().toUpperCase(), side: f.side, qty: Number(f.qty), price: Number(f.price), reason: f.reason.trim() };
  const complete = !!body.symbol && Number.isInteger(body.qty) && body.qty > 0 && body.price > 0;
  const key = JSON.stringify([body.symbol, body.side, body.qty, body.price]);

  // Checked against the limits and the broker a moment after the typing stops.
  useEffect(() => {
    setLook(null);
    setError(null);
    if (!complete) return;
    let live = true;
    const timer = setTimeout(() => {
      api("/api/v1/real-orders/check", { method: "POST", json: body })
        .then((d) => live && setLook(d))
        .catch((e) => live && setError(e.message));
    }, 900);
    return () => { live = false; clearTimeout(timer); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const held = holdings.find((h) => h.symbol === body.symbol);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await api("/api/v1/real-orders", { method: "POST", json: body });
      setF({ ...f, qty: "", price: "", reason: "" });
      onMade(made.id);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="real-ticket">
      <div className="row">
        <div><label htmlFor="ro-symbol">Stock</label>
          <input id="ro-symbol" list="ro-held" value={f.symbol} maxLength={12} placeholder="COMI" autoCapitalize="characters"
            onChange={(e) => setF({ ...f, symbol: e.target.value.toUpperCase() })} />
          <datalist id="ro-held">{holdings.filter((h) => h.symbol).map((h) => <option key={h.symbol} value={h.symbol}>{h.name}</option>)}</datalist></div>
        <div><span className="label-like" id="ro-side">Side</span>
          <div className="seg buy-sell" role="group" aria-labelledby="ro-side">
            {["BUY", "SELL"].map((s) => <button key={s} type="button" className={f.side === s ? "on" : ""} aria-pressed={f.side === s} onClick={() => setF({ ...f, side: s })}>{sideWord(s)}</button>)}
          </div></div>
        <div><label htmlFor="ro-qty">Shares{f.side === "SELL" && held ? ` (${int(held.available)} free to sell)` : ""}</label>
          <input id="ro-qty" inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/[^\d]/g, "") })} /></div>
        <div><label htmlFor="ro-price">Limit price (EGP)</label>
          <input id="ro-price" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/[^\d.]/g, "") })} /></div>
      </div>
      <div className="field" style={{ marginTop: 10 }}><label htmlFor="ro-why">Why? (optional, kept with the order)</label>
        <input id="ro-why" maxLength={600} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></div>
      {look && (
        <p className="muted num" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
          Value {egp(look.facts?.value)} · fees about {egp(look.facts?.est_fees)}
          {look.facts?.reference_price != null && <> · market {price(look.facts.reference_price)}</>}
          {f.side === "BUY" && look.facts?.buying_power != null && <> · you can spend {egp(look.facts.buying_power)}</>}
        </p>
      )}
      {look?.problems?.length > 0 && <div className="note danger" role="alert" style={{ marginTop: 10 }}><ul>{look.problems.map((p: string) => <li key={p}>{p}</li>)}</ul></div>}
      {error && <div className="note danger" role="alert" style={{ marginTop: 10 }}>{error}</div>}
      <div className="form-actions" style={{ marginTop: 12 }}>
        <button type="button" className="primary" disabled={busy || !complete || !look?.ok} onClick={add}>{busy ? "Preparing…" : "Prepare for approval"}</button>
        <span className="muted" style={{ fontSize: 12.5 }}>Nothing is sent yet: the next step shows the order once more and asks you to send it.</span>
      </div>
    </div>
  );
}

/** Real orders on the Real account page: what waits for the owner's decision, a ticket to prepare one, and what was sent. */
export default function RealOrders({ holdings, start, onChanged, auto }: {
  holdings: any[]; start?: { symbol?: string; side?: string }; onChanged: () => void; auto?: any;   // auto: GET /real-orders/auto, when it is on screen
}) {
  const { data, error, reload } = useApi("/api/v1/real-orders");
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [ticket, setTicket] = useState(!!start?.symbol);
  const [failed, setFailed] = useState<string | null>(null);

  // Keep it current: on a timer while something is live, and when another screen (the assistant) changed something.
  const live = useRef(false);
  live.current = !!data && (data.waiting.length > 0 || data.orders.some((o: any) => o.can_cancel || o.in_doubt));
  const last = useRef(0);
  const refresh = useCallback(() => { last.current = Date.now(); reload(); }, [reload]);
  useEffect(() => {
    const timer = setInterval(() => { if (live.current && document.visibilityState === "visible") refresh(); }, RECHECK_MS);
    const onData = () => { if (Date.now() - last.current > QUIET_MS) refresh(); };
    window.addEventListener(DATA_UPDATED, onData);
    return () => { clearInterval(timer); window.removeEventListener(DATA_UPDATED, onData); };
  }, [refresh]);

  const act = async (path: string, question?: string) => {
    if (question && !confirm(question)) return;
    setFailed(null);
    try { await api(path, { method: "POST" }); } catch (e: any) { setFailed(e.message); }
    refresh();
    onChanged();
  };

  if (error) return <div className="card section"><h2>Real orders</h2><div className="note danger" role="alert">{error}</div></div>;
  if (!data) return null;
  const l = data.limits;
  return (
    <div className="card section">
      <div className="card-head">
        <h2>Real orders{data.waiting.length > 0 && <span className="count">{data.waiting.length} waiting for you</span>}</h2>
        <span className={`badge ${data.ready ? "warn" : ""}`}>{!data.ready ? "off" : auto?.on ? "on · automatic inside your box, the rest on your approval" : "on · each one needs your approval"}</span>
      </div>
      {data.ready ? (
        <p className="muted num" style={{ marginTop: 0, fontSize: 12.5 }}>
          Your limits: {egp(Number(l.max_order_value))} per order · {int(l.max_day_orders)} orders and {egp(Number(l.max_day_value))} per day ·
          price at most {num(Number(l.price_band_pct))}% on the costly side of the market. Sent today: {int(data.today.orders)} order{data.today.orders === 1 ? "" : "s"}, {egp(data.today.value)}.{" "}
          <Link href="/settings?tab=real">Change</Link>
        </p>
      ) : (
        <div className="note">{data.why_not} <Link href="/settings?tab=real">Open Real trading settings</Link></div>
      )}
      {data.sync_problem && <div className="note">{data.sync_problem}</div>}
      {failed && <div className="note danger" role="alert">{failed}</div>}

      {data.waiting.length > 0 && (
        <div className="proposals" aria-label="Waiting for your approval">
          {data.waiting.map((o: any) => (
            <div className="proposal" key={o.id}>
              <div>
                <div className="what"><SideBadge side={o.side} /> {int(o.qty)} {o.symbol} <span className="muted">at</span> {price(o.price)} <span className="muted">· {egp(o.value)}</span></div>
                {o.reason && <div className="why" dir="auto">{o.reason}</div>}
                <div className="meta">{o.origin === "assistant" ? "Proposed by the assistant" : o.origin === "automation" ? "Written by the app" : "Prepared by you"} · {clock(o.created_at)} · for the session of {o.session}{levels(o)}</div>
                {auto?.on && auto.waiting?.[o.id] && (auto.waiting[o.id].automatic
                  ? <div className="meta auto-note will" role="status"><strong>Fits your automatic box:</strong> it will be sent without asking you at the app&apos;s next look, within about a minute while the market is open. Decline it to stop that.</div>
                  : o.origin === "assistant" && <div className="meta auto-note">Not sent automatically: {auto.waiting[o.id].why_not.join(" ")}</div>)}
                {o.auto && <div className="meta auto-note">The app tried to send it at {clock(o.auto.at)} and could not: {o.auto.why}</div>}
              </div>
              <div className="acts">
                <button type="button" className="primary" onClick={() => setReviewing(o.id)}><ClipboardCheck size={14} aria-hidden="true" /> Review and send</button>
                <button type="button" onClick={() => act(`/api/v1/real-orders/${o.id}/decline`)}>Decline</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {data.ready && (
        ticket ? <Ticket start={start} holdings={holdings} onMade={(id) => { refresh(); setReviewing(id); }} />
          : <button type="button" style={{ marginTop: data.waiting.length ? 12 : 0 }} onClick={() => setTicket(true)}>Prepare a real order</button>
      )}

      <h3 style={{ marginTop: 20 }}>Sent and decided</h3>
      {data.orders.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th className="l">Order</th><th>Limit</th><th className="l">Outcome</th><th>Filled</th><th className="l col-wide">From</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {data.orders.map((o: any) => (
                <tr key={o.id}>
                  <td>{clock(o.sent_at ?? o.decided_at ?? o.created_at)}</td>
                  <td className="l"><SideBadge side={o.side} /> {int(o.qty)} <Link href={`/stock?symbol=${o.symbol}`}>{o.symbol}</Link>
                    {o.approved_by === "auto" && <small className="sub2" title="Sent on your standing approval, without asking you about this order">
                      {o.origin === "automation" ? "automatic · stop or target" : "automatic"}</small>}</td>
                  <td>{price(o.price)}</td>
                  <td className="l wrap"><Outcome o={o} />{o.status_note && <small className="sub2" dir="auto">{o.status_note}</small>}
                    {o.cancel && o.can_cancel && <small className="sub2">Cancel asked: {o.cancel.outcome}</small>}</td>
                  <td>{o.broker?.order_id ? <div className="cell2"><span>{int(o.broker.executed_qty)} / {int(o.qty)}</span>{o.broker.average ? <small className="muted">avg {price(o.broker.average)}</small> : null}</div> : "—"}</td>
                  <td className="l col-wide muted wrap">{from(o)}</td>
                  <td className="actions">
                    {o.can_cancel && <button type="button" className="small danger" onClick={() => act(`/api/v1/real-orders/${o.id}/cancel`, `Ask the broker to cancel the ${sideWord(o.side).toLowerCase()} order for ${o.qty} ${o.symbol}?`)}>Cancel</button>}
                    {o.status === "unknown" && <button type="button" className="small" onClick={() => act(`/api/v1/real-orders/${o.id}/not-placed`, `Have you checked in the EFG Hermes ONE app that this order for ${o.qty} ${o.symbol} is NOT there?`)}>It was not placed</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty left icon={data.ready ? CircleCheck : TriangleAlert} title="No real orders yet">
          {!data.ready ? "Real orders are off." : auto?.on ? "An order you prepare waits here for your approval. One the assistant proposes inside your automatic box is sent by itself; the rest wait for you."
            : "An order you prepare, or one the assistant proposes, waits here for your approval. Nothing is sent without it."}
        </Empty>
      )}
      <p className="foot-note">
        Limit orders for the day only. {auto?.on
          ? "An order goes to the broker when you approve it, or by itself when it fits the automatic box you set: the assistant's proposals inside it, and the app's own sales at a stop-loss or take-profit."
          : "An order goes to the broker when you approve it and at no other time; the assistant can propose one but cannot send, change or cancel it."}{" "}
        The paper portfolio is not involved.{!auto?.box?.enabled && data.ready ? <> Automatic orders are off · <Link href="/settings?tab=real">set up</Link>.</> : null}
      </p>
      {reviewing && <Review id={reviewing} onClose={(changed) => { setReviewing(null); refresh(); if (changed) onChanged(); }} />}
    </div>
  );
}
