"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { pct, price } from "@/lib/format";
import { useLiveState } from "@/lib/live";

type Rect = { x: number; y: number; w: number; h: number };
type Row = { symbol: string; name: string; sector: string; last: number; change_pct: number | null; turnover: number };

/** Squarified treemap: rectangles as close to squares as the areas allow. Returns one rect per value, in input order. */
function squarify(values: number[], rect: Rect): Rect[] {
  const total = values.reduce((a, b) => a + b, 0);
  const out: Rect[] = new Array(values.length);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return values.map(() => ({ x: rect.x, y: rect.y, w: 0, h: 0 }));
  const scale = (rect.w * rect.h) / total;
  const order = values.map((v, i) => [v * scale, i] as [number, number]).sort((a, b) => b[0] - a[0]);
  let { x, y, w, h } = rect;
  let row: [number, number][] = [];
  const worst = (r: [number, number][], side: number) => {
    const s = r.reduce((a, b) => a + b[0], 0);
    const max = Math.max(...r.map((v) => v[0])), min = Math.min(...r.map((v) => v[0]));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const flush = () => {
    const s = row.reduce((a, b) => a + b[0], 0);
    if (w >= h) {
      const cw = s / h;
      let yy = y;
      for (const [a, i] of row) { out[i] = { x, y: yy, w: cw, h: a / cw }; yy += a / cw; }
      x += cw; w -= cw;
    } else {
      const rh = s / w;
      let xx = x;
      for (const [a, i] of row) { out[i] = { x: xx, y, w: a / rh, h: rh }; xx += a / rh; }
      y += rh; h -= rh;
    }
    row = [];
  };
  for (const item of order) {
    if (item[0] <= 0) { out[item[1]] = { x, y, w: 0, h: 0 }; continue; }
    const side = Math.min(w, h);
    if (row.length && worst([...row, item], side) > worst(row, side)) flush();
    row.push(item);
  }
  if (row.length) flush();
  return out;
}

/* Diverging scale: loss red, slate neutral, gain green. Every step keeps white text above 4.5:1. */
const NEUTRAL = [86, 96, 114], GAIN = [12, 127, 71], LOSS = [194, 48, 60];
const LIMIT = 5; // a move of 5% or more takes the full colour
export function heatColor(change: number | null | undefined): string {
  if (change == null) return `rgb(${NEUTRAL.join(",")})`;
  const t = Math.min(Math.abs(change) / LIMIT, 1);
  const pole = change >= 0 ? GAIN : LOSS;
  return `rgb(${NEUTRAL.map((n, i) => Math.round(n + (pole[i] - n) * t)).join(",")})`;
}

export function HeatScale() {
  const steps = [-5, -3, -1, 0, 1, 3, 5];
  return (
    <div className="scale" aria-label="Colour scale: day change from minus five percent in red to plus five percent in green">
      <span>−5%</span>
      <span className="ramp">{steps.map((s) => <i key={s} style={{ background: heatColor(s) }} />)}</span>
      <span>+5%</span>
    </div>
  );
}

/** The whole market at a glance: stocks grouped by sector, sized by the value traded, coloured by the day's move. */
export default function Treemap({ rows, height = 460 }: { rows: Row[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const { version, quotes } = useLiveState();
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!width) return [];
    // Traded value is very uneven; a square-root scale keeps small stocks visible while larger ones still lead.
    const size = (r: Row) => Math.sqrt(Math.max(r.turnover, 0));
    const groups = new Map<string, Row[]>();
    for (const r of rows) if (size(r) > 0) groups.set(r.sector, [...(groups.get(r.sector) ?? []), r]);
    const sectors = Array.from(groups, ([sector, items]) => ({ sector, items, total: items.reduce((a, r) => a + size(r), 0) }));
    const rects = squarify(sectors.map((s) => s.total), { x: 0, y: 0, w: width, h: height });
    return sectors.map((s, i) => {
      const r = rects[i];
      const head = r.h > 44 && r.w > 60 ? 16 : 0;
      const tiles = squarify(s.items.map(size), { x: 0, y: head, w: r.w, h: r.h - head });
      return { ...s, rect: r, head, tiles };
    });
  }, [rows, width, height]);

  if (!rows.some((r) => r.turnover > 0)) return <div className="empty center">No trading activity to map yet.</div>;
  void version; // re-render as live ticks arrive
  return (
    <div ref={box} className="treemap" style={{ height }} role="group" aria-label="Market map: stocks by sector, sized by traded value, coloured by day change">
      {layout.map((s) => (
        <div key={s.sector} className="sector" style={{ left: s.rect.x, top: s.rect.y, width: s.rect.w, height: s.rect.h }}>
          {s.head > 0 && <div className="t">{s.sector}</div>}
          {s.items.map((r, i) => {
            const t = s.tiles[i];
            if (!t || t.w < 3 || t.h < 3) return null;
            const tick = quotes.get(r.symbol);
            const change = tick?.[1] ?? r.change_pct;
            const last = tick?.[0] ?? r.last;
            const showText = t.w >= 38 && t.h >= 24;
            const font = Math.max(10, Math.min(17, Math.floor(Math.min(t.w / 4.2, t.h / 2.6))));
            return (
              <Link key={r.symbol} href={`/stock?symbol=${r.symbol}`} className="tile"
                title={`${r.symbol} · ${r.name}\n${price(last)}  ${pct(change)}\n${s.sector}`}
                aria-label={`${r.symbol}, ${r.name}, ${pct(change)}`}
                style={{ left: t.x + 1, top: t.y + 1, width: Math.max(t.w - 2, 1), height: Math.max(t.h - 2, 1), background: heatColor(change), color: "#fff", fontSize: font }}>
                {showText && <><b>{r.symbol}</b>{t.h >= 38 && <span style={{ fontSize: Math.max(9.5, font - 2) }}>{pct(change)}</span>}</>}
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );
}
