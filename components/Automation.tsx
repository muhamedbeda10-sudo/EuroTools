"use client";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { egp, int, num, pct, price } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { LinesChart } from "./Charts";
import { Chg, State } from "./ui";

/** Run two to four strategies over the same stocks, period, capital and fees. */
export function CompareStrategies({ strategies, defaultCapital }: { strategies: any[]; defaultCapital: string }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [symbols, setSymbols] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const toggle = (id: string) => setPicked(picked.includes(id) ? picked.filter((p) => p !== id) : picked.length < 4 ? [...picked, id] : picked);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = symbols.split(/[\s,]+/).filter(Boolean);
      setResult(await api("/api/v1/backtests/compare", { method: "POST", json: {
        strategy_ids: picked, symbols: list.length ? list : null, start: start || null, end: end || null,
        capital: defaultCapital ? Number(defaultCapital) : null } }));
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const ROWS: [string, (m: any) => React.ReactNode][] = [
    ["Net return (after fees)", (m) => <Chg v={m.total_return_pct} />],
    ["Gross return", (m) => <Chg v={m.gross_return_pct} />],
    ["Net profit", (m) => egp(m.net_profit)],
    ["Fees", (m) => egp(m.total_fees)],
    ["Maximum drawdown", (m) => <Chg v={m.max_drawdown_pct} />],
    ["Win rate", (m) => (m.win_rate_pct == null ? "—" : `${num(m.win_rate_pct)}%`)],
    ["Closed trades", (m) => int(m.trades)],
    ["Profit factor", (m) => (m.profit_factor == null ? "—" : num(m.profit_factor))],
    ["Average net per trade", (m) => egp(m.avg_net_per_trade)],
    ["Time in the market", (m) => `${num(m.exposure_pct)}%`],
  ];

  return (
    <div className="card section">
      <h2>Compare strategies</h2>
      {strategies.length < 2 ? (
        <div className="empty">Save at least two strategies in <Link href="/strategies">Strategy Management</Link> to compare them.</div>
      ) : (
        <>
          <p className="muted">Pick two to four. They are tested on identical terms: the same stocks, period, starting capital and fee schedule.</p>
          <div className="seg" role="group" aria-label="Strategies to compare" style={{ marginBottom: 12 }}>
            {strategies.map((s) => <button key={s.id} className={picked.includes(s.id) ? "on" : ""} aria-pressed={picked.includes(s.id)} onClick={() => toggle(s.id)}>{s.name}</button>)}
          </div>
          <div className="row">
            <div className="field" style={{ flex: "2 1 240px" }}><label htmlFor="cmp-sym">Stocks (blank = every stock)</label><input id="cmp-sym" value={symbols} onChange={(e) => setSymbols(e.target.value)} placeholder="COMI, TMGH" /></div>
            <div className="field"><label htmlFor="cmp-from">From</label><input id="cmp-from" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="field"><label htmlFor="cmp-to">To</label><input id="cmp-to" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
            <button className="primary fit" disabled={picked.length < 2 || busy} onClick={run}>{busy ? "Running…" : `Compare ${picked.length || ""}`.trim()}</button>
          </div>
          {error && <div className="note danger" role="alert">{error}</div>}
          {result && (
            <>
              <p className="muted" style={{ fontSize: 12 }}>{result.same.stocks} stock(s) · {result.same.period.start} → {result.same.period.end} · starting capital {egp(result.same.capital)}</p>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Metric</th>{result.runs.map((r: any) => <th key={r.id}>{r.name}</th>)}</tr></thead>
                  <tbody>{ROWS.map(([label, cell]) => <tr key={label}><td>{label}</td>{result.runs.map((r: any) => <td key={r.id}>{cell(r.metrics)}</td>)}</tr>)}</tbody>
                </table>
              </div>
              <div style={{ marginTop: 12 }}>
                <LinesChart series={result.runs.slice(0, 3).map((r: any) => ({ name: r.name, points: r.equity_curve.map((p: any) => ({ date: p.date, value: p.equity })) }))} />
              </div>
              {result.runs.some((r: any) => r.metrics.trades < 30) && (
                <div className="note" style={{ marginTop: 10 }}>At least one strategy closed fewer than 30 trades: too few to tell skill from luck.</div>
              )}
              <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Do not choose on return alone. A lower return with a much smaller drawdown and more trades is often the sounder result.</p>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** A saved strategy trading the paper portfolio by itself, on completed sessions. */
export function PaperRuns({ strategies }: { strategies: any[] }) {
  const runs = useApi("/api/v1/paper-runs");
  const [sid, setSid] = useState("");
  const [capital, setCapital] = useState("10000");
  const [symbols, setSymbols] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    setError(null);
    try { await fn(); runs.reload(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const startRun = () => act(async () => {
    const list = symbols.split(/[\s,]+/).filter(Boolean);
    await api("/api/v1/paper-runs", { method: "POST", json: { strategy_id: sid, capital: Number(capital), symbols: list.length ? list : null } });
    setSid("");
  });
  const change = (id: string, status: string) => {
    if (status === "stopped" && !confirm("Stop this run for good? Shares it holds stay in the paper portfolio as ordinary holdings.")) return;
    act(() => api(`/api/v1/paper-runs/${id}`, { method: "PUT", json: { status } }));
  };
  const processNow = () => act(() => api("/api/v1/paper-runs/process", { method: "POST" }));

  return (
    <div className="card">
      <h2><span className="badge paper">Mode 2</span> Automatic paper trading</h2>
      <p className="muted">A strategy places simulated orders in the paper portfolio by itself. It reads signals at each session&apos;s close and fills them at the next session&apos;s open, with the fee schedule and slippage. No order ever goes to a broker.</p>
      {strategies.length === 0 ? (
        <div className="empty">Create a strategy first in <Link href="/strategies">Strategy Management</Link>.</div>
      ) : (
        <div className="row">
          <div className="field"><label htmlFor="pr-s">Strategy</label><select id="pr-s" value={sid} onChange={(e) => setSid(e.target.value)}><option value="">Select…</option>{strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          <div className="field"><label htmlFor="pr-c">Capital for this run (EGP)</label><input id="pr-c" type="number" min="1" value={capital} onChange={(e) => setCapital(e.target.value)} /></div>
          <div className="field"><label htmlFor="pr-sym">Stocks (blank = the strategy&apos;s own)</label><input id="pr-sym" value={symbols} onChange={(e) => setSymbols(e.target.value)} placeholder="COMI, TMGH" /></div>
          <button className="primary fit" disabled={!sid || !Number(capital) || busy} onClick={startRun}>Start</button>
        </div>
      )}
      {error && <div className="note danger" role="alert">{error}</div>}
      <State loading={runs.loading} error={runs.error}>
        {runs.data && runs.data.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>Run</th><th>Status</th><th>Capital</th><th>Value now</th><th>Profit / loss</th><th>Trades</th><th>Up to</th><th>&nbsp;</th></tr></thead>
              <tbody>
                {runs.data.map((r: any) => (
                  <RunRows key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} onChange={change} busy={busy} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </State>
      {runs.data?.some((r: any) => r.status === "active") && (
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Active runs are brought up to date whenever the app loads new daily data. <button className="small" onClick={processNow} disabled={busy}>Check now</button>
        </p>
      )}
    </div>
  );
}

function RunRows({ r, open, onToggle, onChange, busy }: { r: any; open: boolean; onToggle: () => void; onChange: (id: string, s: string) => void; busy: boolean }) {
  return (
    <>
      <tr>
        <td><strong>{r.name}</strong><div className="muted" style={{ fontSize: 12 }}>{r.stocks} stocks{r.current ? "" : " · earlier portfolio"}</div></td>
        <td><span className={`badge ${r.status === "active" ? "ok" : r.status === "paused" ? "warn" : ""}`}>{r.status}</span></td>
        <td>{egp(r.capital)}</td><td>{egp(r.value)}</td>
        <td className={r.pnl > 0 ? "up" : r.pnl < 0 ? "down" : ""}>{egp(r.pnl)} <span className="muted">({pct(r.pnl_pct)})</span></td>
        <td>{r.trades}</td><td>{r.last_date}</td>
        <td>
          <button className="small" aria-expanded={open} onClick={onToggle}>Details</button>{" "}
          {r.status === "active" && <button className="small" disabled={busy} onClick={() => onChange(r.id, "paused")}>Pause</button>}
          {r.status === "paused" && <button className="small" disabled={busy} onClick={() => onChange(r.id, "active")}>Resume</button>}{" "}
          {r.status !== "stopped" && <button className="small danger" disabled={busy} onClick={() => onChange(r.id, "stopped")}>Stop</button>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} className="l wrap" style={{ background: "var(--panel-2)" }}>
            <div className="grid cols-3">
              <dl className="kv">
                <dt>Cash left in the run</dt><dd>{egp(r.cash)}</dd>
                <dt>Realized, net of fees</dt><dd>{egp(r.realized_net)}</dd>
                <dt>Fees paid</dt><dd>{egp(r.fees)}</dd>
                <dt>Waiting to buy at next open</dt><dd>{r.pending_buy.join(", ") || "—"}</dd>
                <dt>Waiting to sell at next open</dt><dd>{r.pending_sell.join(", ") || "—"}</dd>
              </dl>
              <div>
                <strong>Open positions</strong>
                {r.positions.length ? (
                  <table><tbody>{r.positions.map((p: any) => (
                    <tr key={p.symbol}><td><Link href={`/stock?symbol=${p.symbol}`}>{p.symbol}</Link></td><td>{int(p.qty)} @ {price(p.entry_price)}</td>
                      <td>{price(p.last)}</td><td className={p.gross_pnl >= 0 ? "up" : "down"}>{egp(p.gross_pnl)}</td></tr>
                  ))}</tbody></table>
                ) : r.released?.length ? (
                  <div className="muted">None. When it was stopped it held {r.released.map((p: any) => `${int(p.qty)} ${p.symbol}`).join(", ")}:
                    these stay in the portfolio as ordinary holdings, and the run&apos;s result is fixed at that moment.</div>
                ) : <div className="muted">None.</div>}
              </div>
              <div>
                <strong>Notes from the run</strong>
                {r.notes.length ? <ul style={{ margin: "4px 0", paddingLeft: 18 }} className="muted">{r.notes.map((n: string) => <li key={n}>{n}</li>)}</ul> : <div className="muted">None.</div>}
                <p className="muted" style={{ fontSize: 12 }}>Every fill is in <Link href="/trades">Trades &amp; Transactions</Link>, marked “auto”.</p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
