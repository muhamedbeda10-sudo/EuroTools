"use client";
import { FlaskConical, History } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { egp, int, num, pct, price } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { CompareStrategies, PaperRunList, PaperRuns } from "@/components/Automation";
import { LinesChart } from "@/components/Charts";
import { CardHead, Chg, Empty, Kpi, Profit, State } from "@/components/ui";

function Result({ r }: { r: any }) {
  const m = r.metrics;
  return (
    <>
      <div className="card-head" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 16 }}>Backtest result<span className="count">{r.strategy.name}</span></h2>
        <span className="muted num" style={{ fontSize: 12.5 }}>{r.period.start} → {r.period.end} · {r.symbols.length} stock{r.symbols.length === 1 ? "" : "s"}</span>
      </div>
      {r.warnings.length > 0 && <div className="note"><ul>{r.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul></div>}
      <div className="statband four">
        <Profit label="Profit" gross={m.gross_profit} net={m.net_profit} pctNet={m.total_return_pct} />
        <Kpi label="Final value" value={egp(m.liquidation_value)} hint={`From ${egp(m.starting_capital)} · after est. exit fees`} />
        <Kpi label="Fees" value={egp(m.total_fees)} hint={`+ ${egp(m.est_exit_fees_open_positions)} est. to close open positions`} />
        <Kpi label="Maximum drawdown" value={pct(m.max_drawdown_pct)} toneOf={m.max_drawdown_pct} />
        <Kpi label="Closed trades" value={int(m.trades)} hint={`Win rate ${m.win_rate_pct == null ? "—" : num(m.win_rate_pct) + "%"} · in the market ${num(m.exposure_pct)}% of sessions`} />
        <Kpi label="Avg net profit per trade" value={egp(m.avg_net_per_trade)} toneOf={m.avg_net_per_trade} hint={`Profit factor ${m.profit_factor == null ? "—" : num(m.profit_factor)}`} />
        <Kpi label="Best trade (net)" value={m.best_trade ? egp(m.best_trade.net_pnl) : "—"} hint={m.best_trade ? `${m.best_trade.symbol} · exit ${m.best_trade.exit_date}` : undefined} toneOf={m.best_trade?.net_pnl} />
        <Kpi label="Worst trade (net)" value={m.worst_trade ? egp(m.worst_trade.net_pnl) : "—"} hint={m.worst_trade ? `${m.worst_trade.symbol} · exit ${m.worst_trade.exit_date}` : undefined} toneOf={m.worst_trade?.net_pnl} />
      </div>

      <div className="card section">
        <h2>Equity curve vs benchmark</h2>
        <LinesChart series={[
          { name: `Strategy: ${r.strategy.name}`, points: r.equity_curve.map((p: any) => ({ date: p.date, value: p.equity })) },
          ...(r.benchmark ? [{ name: `${r.benchmark.name} rebased (${pct(r.benchmark.return_pct)})`, points: r.benchmark.curve.map((p: any) => ({ date: p.date, value: p.equity })) }] : []),
          { name: `Buy & hold, equal weight, before fees (${pct(r.buy_and_hold.return_pct)})`, points: r.buy_and_hold.curve.map((p: any) => ({ date: p.date, value: p.equity })) },
        ]} />
        <p className="foot-note">
          {r.symbols.length} stock(s) tested · {r.period.sessions} sessions · data: {r.data_sources.join(", ")}. Signals are read at the close and filled at the next session&apos;s open.
        </p>
      </div>

      {r.open_positions.length > 0 && (
        <div className="card section">
          <h2>Positions still open at the end</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Stock</th><th>Qty</th><th>Entry date</th><th>Entry price</th><th>Last price</th><th>Gross P/L</th><th>Net P/L est.</th></tr></thead>
              <tbody>
                {r.open_positions.map((p: any) => (
                  <tr key={p.symbol}><td><Link href={`/stock?symbol=${p.symbol}`}><strong>{p.symbol}</strong></Link></td><td>{int(p.qty)}</td><td>{p.entry_date}</td><td>{price(p.entry_price)}</td><td>{price(p.last_price)}</td>
                    <td className={p.gross_unrealized >= 0 ? "up" : "down"}>{num(p.gross_unrealized)}</td>
                    <td className={p.net_unrealized_est >= 0 ? "up" : "down"}>{num(p.net_unrealized_est)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card section">
        <h2>Simulated trades <span className="count">{r.trades_total > r.trades.length ? `latest ${int(r.trades.length)} of ${int(r.trades_total)}` : r.trades.length}</span></h2>
        {r.trades.length ? (
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
            <table>
              <thead><tr><th>Stock</th><th>Qty</th><th>Entry</th><th>Entry price</th><th>Exit</th><th>Exit price</th><th className="l">Exit reason</th><th>Gross P/L</th><th>Fees</th><th>Net P/L</th><th>Net %</th></tr></thead>
              <tbody>
                {r.trades.map((t: any, i: number) => (
                  <tr key={i}><td><strong>{t.symbol}</strong></td><td>{int(t.qty)}</td><td>{t.entry_date}</td><td>{price(t.entry_price)}</td><td>{t.exit_date}</td><td>{price(t.exit_price)}</td>
                    <td className="l muted">{t.exit_reason.replace(/_/g, " ")}</td>
                    <td className={t.gross_pnl >= 0 ? "up" : "down"}>{num(t.gross_pnl)}</td><td>{num(t.fees)}</td>
                    <td className={t.net_pnl >= 0 ? "up" : "down"}>{num(t.net_pnl)}</td><td><Chg v={t.return_pct} /></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No trades in this period">The strategy&apos;s rules never triggered. Try a longer period or more stocks.</Empty>
        )}
      </div>
    </>
  );
}

function Simulator() {
  const preset = useSearchParams().get("strategy") || "";
  const strategies = useApi("/api/v1/strategies");
  const history = useApi("/api/v1/backtests");
  const app = useApi("/api/v1/settings");
  const runs = useApi("/api/v1/paper-runs");
  const [sid, setSid] = useState(preset);
  const [symbols, setSymbols] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [capital, setCapital] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  useEffect(() => { if (app.data && !capital) setCapital(String(Number(app.data.starting_capital))); }, [app.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen = strategies.data?.find((s: any) => s.id === sid);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const list = symbols.split(/[\s,]+/).filter(Boolean);
      const r = await api("/api/v1/backtests", { method: "POST", json: {
        strategy_id: sid, symbols: list.length ? list : null, start: start || null, end: end || null, capital: capital ? Number(capital) : null,
      } });
      setResult(r);
      history.reload();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const openRun = async (id: string) => {
    setError(null);
    try { setResult(await api(`/api/v1/backtests/${id}`)); window.scrollTo({ top: 0 }); } catch (e: any) { setError(e.message); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Strategy Simulator</h1>
          <p className="sub">Test a strategy on history, or let it trade the paper portfolio. Neither mode can send an order to a broker.</p>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <CardHead title="Historical backtest"><span className="badge paper">Mode 1</span></CardHead>
          <p className="muted">Replay a strategy over past sessions and see what it would have earned after fees and slippage.</p>
          {strategies.data && !strategies.data.length ? (
            <Empty icon={FlaskConical} title="No strategy to test yet" action={<Link className="btn primary" href="/strategies">Create a strategy</Link>}>
              A backtest needs a saved strategy: its rules, risk limits and the stocks it applies to.
            </Empty>
          ) : (
            <>
              <div className="field"><label htmlFor="bt-s">Strategy</label>
                <select id="bt-s" value={sid} onChange={(e) => setSid(e.target.value)}>
                  <option value="">Select a strategy…</option>
                  {strategies.data?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select></div>
              <div className="field"><label htmlFor="bt-sym">Stocks</label>
                <input id="bt-sym" value={symbols} onChange={(e) => setSymbols(e.target.value)}
                  placeholder={`Blank = the strategy's own scope${chosen ? ` (${[...chosen.symbols, ...chosen.sectors].join(", ") || "all stocks"})` : ""}`} /></div>
              <div className="row">
                <div className="field"><label htmlFor="bt-from">From</label><input id="bt-from" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
                <div className="field"><label htmlFor="bt-to">To</label><input id="bt-to" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
                <div className="field"><label htmlFor="bt-cap">Starting capital (EGP)</label><input id="bt-cap" type="number" min="1" value={capital} onChange={(e) => setCapital(e.target.value)} /></div>
              </div>
              {error && <div className="note danger" role="alert">{error}</div>}
              <div className="form-actions">
                <button className="primary" disabled={!sid || busy} onClick={run}>{busy ? "Running…" : "Run backtest"}</button>
                <span className="muted" style={{ fontSize: 12 }}>Blank dates use the whole history.</span>
              </div>
              <p className="foot-note">Entry / exit rules, risk limits and slippage come from the strategy. Fees come from the schedule in Settings.</p>
            </>
          )}
        </div>
        <PaperRuns strategies={strategies.data ?? []} runs={runs} />
      </div>

      {result && <div className="section"><Result r={result} /></div>}

      <PaperRunList runs={runs} />

      <CompareStrategies strategies={strategies.data ?? []} defaultCapital={capital} />

      <div className="card section">
        <h2>Previous runs</h2>
        <State loading={history.loading} error={history.error}>
          {history.data &&
            (history.data.length ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Strategy</th><th className="l">Period</th><th className="col-wide">Stocks</th><th>Gross return</th><th>Net return</th><th>Max drawdown</th><th>Win rate</th><th>Trades</th>
                    <th><span className="sr-only">Open</span></th></tr></thead>
                  <tbody>
                    {history.data.map((h: any) => (
                      <tr key={h.id}>
                        <td><strong>{h.strategy_name}</strong><span className="sub2">run {h.ts.slice(0, 16).replace("T", " ")} UTC</span></td>
                        <td className="l">{h.period.start} → {h.period.end}</td><td className="col-wide">{h.symbols.length}</td>
                        <td><Chg v={h.metrics.gross_return_pct} /></td><td><Chg v={h.metrics.total_return_pct} /></td>
                        <td><Chg v={h.metrics.max_drawdown_pct} /></td>
                        <td>{h.metrics.win_rate_pct == null ? "—" : `${num(h.metrics.win_rate_pct)}%`}</td><td>{h.metrics.trades}</td>
                        <td><button className="small" onClick={() => openRun(h.id)}>Open</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon={History} title="No backtests yet">Each run is saved here so you can open it again.</Empty>
            ))}
        </State>
        <p className="foot-note">Compare runs only when the period, stocks and fee assumptions match. Return alone is not enough: check drawdown, number of trades and consistency.</p>
      </div>
    </>
  );
}

export default function SimulatorPage() {
  return <Suspense fallback={<div className="empty">Loading…</div>}><Simulator /></Suspense>;
}
