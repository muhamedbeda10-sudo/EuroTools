"use client";
import { ArrowDown, ArrowUp, Search, Star } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { LiveChg, LiveLast, LiveVolume } from "./LiveCells";
import { Chg, Empty, SourceTag, Spark } from "./ui";

type Key = "symbol" | "sector" | "last" | "change_pct" | "week_pct" | "month_pct" | "volume";
const COLUMNS: { key: Key; label: string; left?: boolean }[] = [
  { key: "symbol", label: "Stock", left: true }, { key: "sector", label: "Sector", left: true }, { key: "last", label: "Last" },
  { key: "change_pct", label: "Day" }, { key: "week_pct", label: "Week" }, { key: "month_pct", label: "Month" }, { key: "volume", label: "Volume" },
];

/** Stocks, sortable by any column. Prices, day change and volume follow the live stream. */
export default function StockTable({ rows, onChange, empty = "No stocks to show.", limit }: {
  rows: any[]; onChange?: () => void; empty?: string; limit?: number;
}) {
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: "symbol", dir: 1 });
  const sorted = useMemo(() => {
    const out = [...rows].sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      if (x == null && y == null) return 0;
      if (x == null) return 1; // rows with no value go last whichever way the column is sorted
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * sort.dir;
    });
    return limit ? out.slice(0, limit) : out;
  }, [rows, sort, limit]);
  if (!rows.length) return <Empty icon={Search} title={empty} />;

  const toggle = async (r: any) => {
    await api(`/api/v1/watchlist/${r.symbol}`, { method: r.watched ? "DELETE" : "PUT" });
    onChange?.();
  };
  const by = (key: Key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "symbol" || key === "sector" ? 1 : -1 }));

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.key} className={c.left ? "l" : ""} aria-sort={sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
                <button className="sort" onClick={() => by(c.key)}>
                  {c.label}{sort.key === c.key && (sort.dir === 1 ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />)}
                </button>
              </th>
            ))}
            <th className="col-wide">30 sessions</th><th><span className="sr-only">Watchlist</span></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r.symbol}>
              <td><div className="sym"><Link href={`/stock?symbol=${r.symbol}`}>{r.symbol}</Link><span title={r.name}>{r.name}</span></div></td>
              <td className="l muted"><span className="trunc" style={{ maxWidth: 190 }} title={r.sector}>{r.sector}</span> <SourceTag source={r.source} /></td>
              <td><LiveLast symbol={r.symbol} last={r.last} /></td>
              <td>{r.current === false
                ? <span className="muted" title={`Did not trade in the latest session. Last traded ${r.as_of}.`}>last {String(r.as_of).slice(5)}</span>
                : <LiveChg symbol={r.symbol} value={r.change_pct} />}</td>
              <td><Chg v={r.week_pct} /></td>
              <td><Chg v={r.month_pct} /></td>
              <td><LiveVolume symbol={r.symbol} value={r.volume} /></td>
              <td className="col-wide"><Spark data={r.spark} width={84} /></td>
              <td>
                <button className={`icon-btn ghost small ${r.watched ? "on" : ""}`} onClick={() => toggle(r)} aria-pressed={r.watched}
                  aria-label={`${r.watched ? "Remove" : "Add"} ${r.symbol} ${r.watched ? "from" : "to"} watchlist`} title={r.watched ? "Watching" : "Watch"}>
                  <Star size={15} fill={r.watched ? "currentColor" : "none"} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
