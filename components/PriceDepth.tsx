"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { int, num } from "@/lib/format";

type Level = { price: number; size: number; orders: number | null };
const px = (v?: number | null) => (v == null ? "—" : v < 10 ? v.toFixed(3) : v.toFixed(2));
const REFRESH_MS = 15000;

/** Cumulative size at each price, drawn as two step areas meeting at the spread. */
function DepthChart({ bids, asks }: { bids: Level[]; asks: Level[] }) {
  if (!bids.length || !asks.length) return null;
  const W = 640, H = 220, PAD = 4;
  const cum = (levels: Level[]) => { let t = 0; return levels.map((l) => ({ price: l.price, total: (t += l.size) })); };
  const b = cum(bids), a = cum(asks);
  const lo = b[b.length - 1].price, hi = a[a.length - 1].price, mid = (bids[0].price + asks[0].price) / 2;
  const top = Math.max(b[b.length - 1].total, a[a.length - 1].total) || 1;
  // each side gets half the width, so a lopsided book is still readable
  const x = (p: number) => (p <= mid ? ((p - lo) / (mid - lo || 1)) * (W / 2) : W / 2 + ((p - mid) / (hi - mid || 1)) * (W / 2));
  const y = (t: number) => H - PAD - (t / top) * (H - 2 * PAD);
  const steps = (pts: { price: number; total: number }[]) => {
    let d = `M ${x(mid)} ${y(0)}`, prev = 0;
    for (const p of pts) { d += ` L ${x(p.price)} ${y(prev)} L ${x(p.price)} ${y(p.total)}`; prev = p.total; }
    return d;
  };
  const area = (pts: { price: number; total: number }[]) => `${steps(pts)} L ${x(pts[pts.length - 1].price)} ${y(0)} Z`;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
        aria-label={`Depth chart: ${int(b[b.length - 1].total)} shares bid down to ${px(lo)}, ${int(a[a.length - 1].total)} shares offered up to ${px(hi)}`}>
        <path d={area(b)} fill="var(--up)" opacity="0.18" /><path d={steps(b)} fill="none" stroke="var(--up)" strokeWidth="2" />
        <path d={area(a)} fill="var(--down)" opacity="0.18" /><path d={steps(a)} fill="none" stroke="var(--down)" strokeWidth="2" />
        <line x1={W / 2} x2={W / 2} y1={0} y2={H} stroke="var(--muted)" strokeDasharray="4 4" />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }} className="muted">
        <span>{px(lo)}</span><span>{px(bids[0].price)} / {px(asks[0].price)}</span><span>{px(hi)}</span>
      </div>
    </div>
  );
}

type Stream = { tick: any; state: "connecting" | "live" | "failed"; error: string | null; at: Date | null };

/** The order book of a stock. Given a working live stream it shows every change as it
 *  happens; without one (or if the stream fails) it asks again every 15 seconds.
 *
 *  The feed usually sends the best bid and ask and the totals, and no price levels behind
 *  them (`top_only`). The panel then says so, and leaves out the chart and the table, which
 *  would have one step and one row to show. */
export default function PriceDepth({ symbol, stream }: { symbol: string; stream?: Stream }) {
  const [polled, setPolled] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const live = useRef(true);
  const streaming = !!stream && stream.state !== "failed";
  const setBook = setPolled;

  useEffect(() => {
    if (streaming) return;
    live.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (document.visibilityState === "visible") {
        try {
          const b = await api(`/api/v1/stocks/${symbol}/depth`);
          if (!live.current) return;
          setBook(b);
          setError(null);
        } catch (e: any) {
          if (!live.current) return;
          setError(e.message);
        } finally {
          if (live.current) setLoading(false);
        }
      }
      timer = setTimeout(load, REFRESH_MS);
    };
    load();
    return () => { live.current = false; clearTimeout(timer); };
  }, [symbol, streaming]);

  const book = streaming && stream!.tick
    ? { ...stream!.tick.depth, as_of: stream!.at?.toISOString(), streamed: true }
    : streaming ? null : polled;
  if (streaming && !book) return <div className="empty">Connecting to the live order book…</div>;
  if (loading && !book) return <div className="empty">Loading the order book…</div>;
  if (error && !book) return <div className="note danger" role="alert">{error}</div>;
  if (!book) return null;
  const { bids, asks } = book as { bids: Level[]; asks: Level[] };
  const rows = Math.min(Math.max(bids.length, asks.length), 15);
  const maxSize = Math.max(1, ...bids.slice(0, rows).map((l) => l.size), ...asks.slice(0, rows).map((l) => l.size));
  const share = book.bid_share_pct;
  const topOnly: string[] = book.top_only ?? [];   // sides for which the feed sent a best price and no levels
  const bestOnly = topOnly.length === 2;           // neither side has levels: nothing to chart or to list

  return (
    <div>
      <p className="muted" style={{ fontSize: 12 }}>
        {bestOnly ? "The best buy price (green) and the best sell price (red), and the shares waiting on each side." : "Buy orders (green) and sell orders (red) waiting at each price."}{" "}
        {book.streamed
          ? <><span className="badge ok">● live</span> updating as orders change · last change {stream!.at?.toLocaleTimeString()}</>
          : <>As of {String(book.as_of).slice(11, 19)} Cairo{book.market_open ? ", refreshed every 15 seconds." : ". The market is closed: this is the book as it was left."}</>}
      </p>
      {stream?.state === "failed" && <div className="note" role="status">The live stream is not available ({stream.error ?? "no connection"}); refreshing every 15 seconds instead.</div>}
      {error && <div className="note" role="status">Could not refresh: {error}</div>}
      {!bids.length && !asks.length ? (
        <div className="empty">The feed has no orders for this stock right now.</div>
      ) : (
        <>
          <div className="pair" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <div><div className="label">Highest bid</div><div className="v up" style={{ fontSize: 20 }}>EGP {px(book.best_bid)}</div><div className="muted">× {int(book.best_bid_size)}</div></div>
            <div style={{ textAlign: "right" }}><div className="label">Lowest ask</div><div className="v down" style={{ fontSize: 20 }}>EGP {px(book.best_ask)}</div><div className="muted">× {int(book.best_ask_size)}</div></div>
          </div>
          {!bestOnly && <DepthChart bids={bids} asks={asks} />}
          <p style={{ margin: bestOnly ? "0 0 6px" : "12px 0 6px" }}><strong>Spread</strong> EGP {px(book.spread)} {book.spread_pct != null && <span className="muted">({num(book.spread_pct)}%)</span>}</p>
          {share != null && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span className="up">{num(share)}% buyers</span><span className="down">{num(100 - share)}% sellers</span>
              </div>
              <div style={{ display: "flex", gap: 4, height: 6, margin: "4px 0" }} role="img" aria-label={`${num(share)} percent of waiting shares are bids`}>
                <span style={{ width: `${share}%`, background: "var(--up)", borderRadius: 3 }} />
                <span style={{ flex: 1, background: "var(--down)", borderRadius: 3 }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }} className="muted">
                <span>{int(book.total_bids)} shares</span><span>{int(book.total_asks)} shares</span>
              </div>
            </div>
          )}
          {topOnly.length > 0 && !book.unread && (
            <div className="note info" role="note" style={{ marginBottom: bestOnly ? 0 : 12 }}>
              {bestOnly
                ? "The market-data feed sends the best bid and the best ask only. The price levels behind them, which a broker's own app lists, do not reach this app."
                : `The market-data feed sent no price levels behind the best ${topOnly[0] === "bids" ? "bid" : "ask"}.`}
            </div>
          )}
          {!bestOnly && <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>Size</th><th>Bid</th><th className="l">Ask</th><th className="l">Size</th><th className="l">#</th></tr></thead>
              <tbody>
                {Array.from({ length: rows }, (_, i) => {
                  const bd = bids[i], ak = asks[i];
                  const bar = (l: Level | undefined, color: string, side: "left" | "right") =>
                    l ? { background: `linear-gradient(to ${side}, color-mix(in srgb, ${color} 22%, transparent) ${(l.size / maxSize) * 100}%, transparent 0)` } : undefined;
                  return (
                    <tr key={i}>
                      <td className="muted">{bd?.orders ?? ""}</td><td>{bd ? int(bd.size) : ""}</td>
                      <td className="up" style={bar(bd, "var(--up)", "left")}>{bd ? px(bd.price) : ""}</td>
                      <td className="l down" style={bar(ak, "var(--down)", "right")}>{ak ? px(ak.price) : ""}</td>
                      <td className="l">{ak ? int(ak.size) : ""}</td><td className="l muted">{ak?.orders ?? ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>}
        </>
      )}
      {book.unread && (
        <details style={{ marginTop: 10 }}>
          <summary className="muted">Only the best price is shown: the full book arrived in a layout this version cannot read yet</summary>
          <p className="muted" style={{ fontSize: 12, wordBreak: "break-all" }}>
            {Object.entries(book.unread).map(([side, text]) => `${side}: ${text}`).join("  ·  ")}
          </p>
        </details>
      )}
    </div>
  );
}
