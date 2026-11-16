"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { egp, pct, tone } from "@/lib/format";
import { useIndexTick } from "@/lib/live";
import { useApi } from "@/lib/useApi";
import { LiveChg, LiveLast } from "./LiveCells";

function IndexItem({ i }: { i: any }) {
  const tick = useIndexTick(i.symbol);
  const value = tick?.[0] ?? i.last;
  const change = tick?.[1] ?? i.change_pct;
  return (
    <span className="it">
      <b>{i.symbol}</b>
      <span className="v">{value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
      <span className={tone(change)}>{pct(change)}</span>
    </span>
  );
}

const PAUSED = "egx-ticker-paused";
const SPEED = 42;   // pixels a second: slow enough to read a price as it passes

/** The figures a trader wants in the corner of every screen, as a tape that keeps moving: the indices, breadth,
 *  the paper portfolio, then the day's most active stocks, gainers and losers (each opens its stock page).
 *
 *  It asks the server for nothing new: the same two readings the strip always made. The tape is written twice,
 *  one copy after the other, and slides by exactly one copy, so it never shows a gap; the second copy is
 *  hidden from the keyboard and from screen readers. It stops under the pointer or the keyboard's focus, the
 *  button at its start stops it for good (kept for this browser), and where the system asks for less motion
 *  it does not move at all and can be scrolled by hand instead. */
export default function MarketStrip() {
  const ov = useApi("/api/v1/market/overview");
  const pf = useApi("/api/v1/portfolio");
  const [paused, setPaused] = useState(false);
  const [seconds, setSeconds] = useState(60);
  const [fits, setFits] = useState(false);   // the whole tape is in view already: nothing to move
  const set = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try { setPaused(localStorage.getItem(PAUSED) === "1"); } catch {}
  }, []);
  const toggle = () => setPaused((p) => {
    try { localStorage.setItem(PAUSED, p ? "0" : "1"); } catch {}
    return !p;
  });
  const b = ov.data?.breadth;
  const s = pf.data?.summary;
  // one of each stock, the most active first: the names a trader looks for
  const stocks: any[] = [];
  for (const row of [...(ov.data?.most_active ?? []), ...(ov.data?.gainers ?? []), ...(ov.data?.losers ?? [])]) {
    if (!stocks.some((x) => x.symbol === row.symbol)) stocks.push(row);
  }
  // The same pace however much is on the tape: the time one pass takes follows its width.
  const count = (ov.data?.indices?.length ?? 0) + stocks.length + (s ? 2 : 0);
  useEffect(() => {
    const el = set.current;
    if (!el) return;
    const view = el.parentElement?.parentElement;
    const measure = () => {
      setSeconds(Math.max(20, Math.round(el.scrollWidth / SPEED)));
      setFits(!!view && el.scrollWidth <= view.clientWidth);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    if (view) watch.observe(view);
    return () => watch.disconnect();
  }, [count]);
  if (!ov.data && !pf.data) return null;

  const tape = (
    <>
      {ov.data?.indices?.map((i: any) => <IndexItem key={i.symbol} i={i} />)}
      {b && (
        <span className="it"><b>Breadth</b>
          <span className="up">{b.advancers} up</span><span className="down">{b.decliners} down</span><span className="muted">{b.unchanged} flat</span>
        </span>
      )}
      {s && (
        <>
          <span className="it"><b>Paper portfolio</b><span className="v">{egp(s.total_value)}</span>
            <span className={tone(s.total_net)}>{pct(s.return_net_pct)} net</span></span>
          <span className="it"><b>Cash</b><span className="v">{egp(s.cash)}</span></span>
        </>
      )}
      {stocks.length > 0 && <span className="sep" aria-hidden="true" />}
      {stocks.map((q) => (
        <Link key={q.symbol} className="it" href={`/stock?symbol=${q.symbol}`} title={q.name}>
          <b>{q.symbol}</b><span className="v"><LiveLast symbol={q.symbol} last={q.last} /></span><LiveChg symbol={q.symbol} value={q.change_pct} />
        </Link>
      ))}
      <span className="sep" aria-hidden="true" />
    </>
  );
  return (
    <div className={`strip ticker ${paused || fits ? "paused" : ""}`} role="region" aria-label="Market summary">
      <button type="button" className="ticker-toggle" hidden={fits} onClick={toggle} aria-pressed={paused}
        aria-label={paused ? "Let the prices move again" : "Stop the moving prices"} title={paused ? "Let the prices move again" : "Stop the moving prices"}>
        {paused ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
      </button>
      <div className="ticker-view" tabIndex={0}>
        <div className="ticker-track" style={{ animationDuration: `${seconds}s` }}>
          <div className="ticker-set" ref={set}>{tape}</div>
          <div className="ticker-set copy" aria-hidden="true" inert>{tape}</div>
        </div>
      </div>
    </div>
  );
}
