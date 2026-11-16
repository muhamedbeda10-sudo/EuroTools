"use client";
import { big, pct, price, tone } from "@/lib/format";
import { Flash, useIndexTick, useTick } from "@/lib/live";

/** Last price of a stock: the streamed tick when there is one, the server's figure otherwise. */
export function LiveLast({ symbol, last }: { symbol: string; last?: number | null }) {
  const tick = useTick(symbol);
  const value = tick?.[0] ?? last;
  return <Flash value={value}>{price(value)}</Flash>;
}

/** What a stock is at now, beside a price it was traded at: the price, and under it how far it has moved since. */
export function LiveSince({ symbol, from, last }: { symbol: string; from?: number | null; last?: number | null }) {
  const tick = useTick(symbol);
  const value = tick?.[0] ?? last;
  if (value == null) return <>—</>;
  const move = from ? ((value - from) / from) * 100 : null;
  return (
    <div className="cell2">
      <Flash value={value}>{price(value)}</Flash>
      <small className={tone(move)}>{pct(move)}</small>
    </div>
  );
}

export function LiveChg({ symbol, value }: { symbol: string; value?: number | null }) {
  const tick = useTick(symbol);
  const v = tick?.[1] ?? value;
  return <span className={tone(v)}><span aria-hidden="true" style={{ fontSize: "0.72em" }}>{v == null || v === 0 ? "" : v > 0 ? "▲ " : "▼ "}</span>{pct(v)}</span>;
}

export function LiveVolume({ symbol, value }: { symbol: string; value?: number | null }) {
  const tick = useTick(symbol);
  return <>{big(tick?.[2] ?? value)}</>;
}

/** An index level and its day change, stacked: the streamed tick when there is one. */
export function LiveIndex({ name, last, changePct }: { name: string; last?: number | null; changePct?: number | null }) {
  const tick = useIndexTick(name);
  const value = tick?.[0] ?? last;
  const change = tick?.[1] ?? changePct;
  return (
    <div className="val">
      <b><Flash value={value}>{value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 })}</Flash></b>
      <span className={tone(change)}><span aria-hidden="true" style={{ fontSize: "0.72em" }}>{change == null || change === 0 ? "" : change > 0 ? "▲ " : "▼ "}</span>{pct(change)}</span>
    </div>
  );
}
