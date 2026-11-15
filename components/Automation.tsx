"use client";
import { Bot, ChevronDown, ChevronUp, GitCompareArrows } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { egp, int, num, pct, price } from "@/lib/format";
import { LinesChart } from "./Charts";
import { CardHead, Chg, Empty, State } from "./ui";

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
        <Empty icon={GitCompareArrows} title="Two strategies are needed">Save at least two in <Link href="/strategies">Strategy Management</Link> to compare them on identical terms.</Empty>
      ) : (
        <>
          <p className="muted">Pick two to four. They are tested on identical terms: the same stocks, period, starting capital and fee schedule.</p>
          <div className="seg wrap" role="group" aria-label="Strategies to compare" style={{ marginBottom: 14 }}>
            {strategies.map((s) => <button key={s.id} className={picked.includes(s.id) ? "on" : ""} aria-pressed={picked.includes(s.id)} onClick={() => toggle(s.id)}>{s.name}</button>)}
          </div>
          <div className="row">
            <div className="field" style={{ flex: "2 1 240px" }}><label htmlFor="cmp-sym">Stocks</label><input id="cmp-sym" value={symbols} onChange={(e) => setSymbols(e.target.value)} placeholder="Blank = every stock" /></div>
            <div className="field"><label htmlFor="cmp-from">From</label><input id="cmp-from" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="field"><label htmlFor="cmp-to">To</label><input id="cmp-to" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
            <button className="primary fit" disabled={picked.length < 2 || busy} onClick={run}>{busy ? "Running…" : `Compare ${picked.length || ""}`.trim()}</button>
          </div>
          {error && <div className="note danger" role="alert">{error}</div>}
          {result && (
            <>
              <p className="foot-note" style={{ marginBottom: 12 }}>{result.same.stocks} stock(s) · {result.same.period.start} → {result.same.period.end} · starting capital {egp(result.same.capital)}</p>
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
              <p className="foot-note">Do not choose on return alone. A lower return with a much smaller drawdown and more trades is often the sounder result.</p>
            </>
          )}
        </>
      )}
    </div>
  );
}

type Runs = { data: any[] | null; loading: boolean; error: string | null; reload: () => void };

/** A saved strategy trading the paper portfolio by itself, on completed sessions: the form that starts a run. */
export function PaperRuns({ strategies, runs }: { strategies: any[]; runs: Runs }) {
  const [sid, setSid] = useState("");
  const [capital, setCapital] = useState("10000");
  const [symbols, setSymbols] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const startRun = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = symbols.split(/[\s,]+/).filter(Boolean);
      await api("/api/v1/paper-runs", { method: "POST", json: { strategy_id: sid, capital: Number(capital), symbols: list.length ? list : null } });
      setSid("");
      runs.reload();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="card">
      <CardHead title="Automatic paper trading"><span className="badge paper">Mode 2</span></CardHead>
      <p className="muted">A strategy places simulated orders in the paper portfolio by itself: signals are read at each session&apos;s close and filled at the next open, with fees and slippage. No order ever goes to a broker.</p>
      {strategies.length === 0 ? (
        <Empty icon={Bot} title="No strategy to run yet" action={<Link className="btn primary" href="/strategies">Create a strategy</Link>}>
          An automatic run follows one saved strategy with its own slice of the paper cash.
        </Empty>
      ) : (
        <>
          <div className="field"><label htmlFor="pr-s">Strategy</label><select id="pr-s" value={sid} onChange={(e) => setSid(e.target.value)}><option value="">Select a strategy…</option>{strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
          <div className="field"><label htmlFor="pr-sym">Stocks</label><input id="pr-sym" value={symbols} onChange={(e) => setSymbols(e.target.value)} placeholder="Blank = the strategy's own scope" /></div>
          <div className="field" style={{ maxWidth: 260 }}><label htmlFor="pr-c">Capital for this run (EGP)</label><input id="pr-c" type="number" min="1" value={capital} onChange={(e) => setCapital(e.target.value)} /></div>
          {error && <div className="note danger" role="alert">{error}</div>}
          <div className="form-actions">
            <button className="primary" disabled={!sid || !Number(capital) || busy} onClick={startRun}>{busy ? "Starting…" : "Start automatic run"}</button>
            <span className="muted" style={{ fontSize: 12 }}>The capital is set aside from the paper cash.</span>
          </div>
          <p className="foot-note">Runs appear in the list below, where each can be paused or stopped.</p>
        </>
      )}
    </div>
  );
}

/** Every automatic run, with what it is worth now and the controls to pause or stop it. */
export function PaperRunList({ runs }: { runs: Runs }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    setError(null);
    try { await fn(); runs.reload(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const change = (id: string, status: string) => {
    if (status === "stopped" && !confirm("Stop this run for good? Shares it holds stay in the paper portfolio as ordinary holdings.")) return;
    act(() => api(`/api/v1/paper-runs/${id}`, { method: "PUT", json: { status } }));
  };
  const processNow = () => act(() => api("/api/v1/paper-runs/process", { method: "POST" }));
  if (!runs.data?.length && !runs.error) return null; // nothing started yet: the form above says how

  return (
    <div className="card section">
      <CardHead title={<>Automatic runs<span className="count">{runs.data?.length ?? 0}</span></>}>
        {runs.data?.some((r: any) => r.status === "active") && <button className="small" onClick={processNow} disabled={busy}>Check now</button>}
      </CardHead>
      {error && <div className="note danger" role="alert">{error}</div>}
      <State loading={runs.loading} error={runs.error}>
        {runs.data && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Run</th><th className="l">Status</th><th>Capital</th><th>Value now</th><th>Profit / loss</th><th>Trades</th><th>Up to</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {runs.data.map((r: any) => (
                  <RunRows key={r.id} r={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} onChange={change} busy={busy} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </State>
      <p className="foot-note">Active runs are brought up to date whenever the app loads new daily data.</p>
    </div>
  );
}

function RunRows({ r, open, onToggle, onChange, busy }: { r: any; open: boolean; onToggle: () => void; onChange: (id: string, s: string) => void; busy: boolean }) {
  return (
    <>
      <tr>
        <td><strong>{r.name}</strong><span className="sub2">{r.stocks} stocks{r.current ? "" : " · earlier portfolio"}</span></td>
        <td className="l"><span className={`badge ${r.status === "active" ? "ok" : r.status === "paused" ? "warn" : ""}`}>{r.status === "active" && <span className="dot" />}{r.status}</span></td>
        <td>{egp(r.capital)}</td><td>{egp(r.value)}</td>
        <td className={r.pnl > 0 ? "up" : r.pnl < 0 ? "down" : ""}>{egp(r.pnl)} <span className="muted">({pct(r.pnl_pct)})</span></td>
        <td>{r.trades}</td><td>{r.last_date}</td>
        <td className="actions">
          {r.status === "active" && <button className="small" disabled={busy} onClick={() => onChange(r.id, "paused")}>Pause</button>}
          {r.status === "paused" && <button className="small" disabled={busy} onClick={() => onChange(r.id, "active")}>Resume</button>}
          {r.status !== "stopped" && <button className="small danger" disabled={busy} onClick={() => onChange(r.id, "stopped")}>Stop</button>}
          <button className="icon-btn ghost small" aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the details of ${r.name}`} title="Details" onClick={onToggle}>
            {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={8} className="l wrap">
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
                <p className="foot-note">Every fill is in <Link href="/trades">Trades &amp; Transactions</Link>, marked “auto”.</p>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
