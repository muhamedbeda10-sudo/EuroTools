"use client";
import Link from "next/link";
import { egp, int, num, pct, price } from "@/lib/format";
import { Flash, useTick } from "@/lib/live";
import { useApi } from "@/lib/useApi";
import { LinesChart } from "@/components/Charts";
import { Chg, Kpi, Profit, SourceTag, State } from "@/components/ui";

const CAT = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `var(--cat-${n})`);

/** One whole split into parts. Colours are assigned in fixed order; beyond seven parts the rest fold into "Other". */
function Allocation({ parts, cashWeight }: { parts: { name: string; weight: number; value: number }[]; cashWeight: number }) {
  if (!parts.length) return <div className="empty">Nothing invested yet: the portfolio is all cash.</div>;
  const shown = parts.slice(0, 7);
  const rest = parts.slice(7);
  const rows = [...shown, ...(rest.length ? [{ name: `Other (${rest.length})`, weight: rest.reduce((a, r) => a + r.weight, 0), value: rest.reduce((a, r) => a + r.value, 0) }] : [])];
  const label = rows.map((r) => `${r.name} ${num(r.weight)}%`).join(", ") + `, cash ${num(cashWeight)}%`;
  return (
    <>
      <div className="segbar tall" role="img" aria-label={`Allocation: ${label}`}>
        {rows.map((r, i) => (
          <span key={r.name} title={`${r.name}: ${egp(r.value)} · ${num(r.weight)}%`} style={{ width: `${r.weight}%`, background: CAT[i] }} />
        ))}
        {cashWeight > 0 && <span title={`Cash: ${num(cashWeight)}%`} style={{ width: `${cashWeight}%`, background: "var(--border-strong)" }} />}
      </div>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.name}><td><i style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: CAT[i], marginRight: 8 }} />{r.name}</td>
                <td>{egp(r.value)}</td><td>{num(r.weight)}%</td></tr>
            ))}
            <tr><td><i style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: "var(--border-strong)", marginRight: 8 }} />Cash</td>
              <td className="muted">—</td><td>{num(cashWeight)}%</td></tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

/** One holding. Last price, market value and gross P/L follow the live tick; the net estimate
 *  (which needs the fee schedule) stays the server's figure until the next refresh. */
function HoldingRow({ h }: { h: any }) {
  const tick = useTick(h.symbol);
  const last = tick?.[0] ?? h.last;
  const value = tick ? last * h.qty : h.market_value;
  const gross = tick ? value - h.cost : h.unrealized_gross;
  const grossPct = tick && h.cost ? (gross / h.cost) * 100 : h.unrealized_gross_pct;
  return (
    <tr>
      <td><div className="sym"><Link href={`/stock?symbol=${h.symbol}`}>{h.symbol}</Link><span title={h.name}>{h.name}</span></div></td>
      <td className="l muted">{h.sector} <SourceTag source={h.source} live={!!tick} /></td><td>{int(h.qty)}</td><td>{price(h.avg_price)}</td>
      <td><Flash value={last}>{price(last)}</Flash></td>
      <td>{egp(value)}</td><td>{num(h.weight_pct)}%</td>
      <td className={gross > 0 ? "up" : gross < 0 ? "down" : ""}>{egp(gross)}</td>
      <td><Chg v={grossPct} /></td>
      <td className={h.unrealized_net_est > 0 ? "up" : h.unrealized_net_est < 0 ? "down" : ""}>{egp(h.unrealized_net_est)}</td>
    </tr>
  );
}

export default function Portfolio() {
  const { data, loading, error } = useApi("/api/v1/portfolio");
  const s = data?.summary;
  const hist = data?.history;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Portfolio</h1>
          <p className="sub">The simulated investment. Every figure is derived from the trade ledger.</p>
        </div>
        <Link className="btn" href="/trades">View ledger</Link>
      </div>
      <State loading={loading} error={error}>
        {s && (
          <>
            {data.warnings.length > 0 && <div className="note"><ul>{data.warnings.map((w: string) => <li key={w}>{w}</li>)}</ul></div>}
            <div className="grid cols-4">
              <Kpi label="Total value" value={egp(s.total_value)} delta={s.return_net_pct} hint={`net, from ${egp(s.starting_capital)}`} />
              <Kpi label="Cash balance" value={egp(s.cash)} hint={`${num(data.cash_weight_pct)}% of portfolio`} />
              <Kpi label="Invested (at cost)" value={egp(s.invested_cost)} hint={`Market value ${egp(s.market_value)}`} />
              <Kpi label="Fees paid" value={egp(s.fees_paid)} hint={`Est. fees to exit all positions ${egp(s.est_exit_fees)}${s.fees_verified ? "" : " · schedule unverified"}`} />
            </div>
            <div className="grid cols-3 section">
              <Profit label="Realized" gross={s.realized_gross} net={s.realized_net} />
              <Profit label="Unrealized" gross={s.unrealized_gross} net={s.unrealized_net_est} netLabel="Net est. after exit fees" />
              <Profit label="Total return" gross={s.total_gross} net={s.total_net} pctNet={s.return_net_pct} />
            </div>

            <div className="card flush section">
              <div className="card-head" style={{ padding: "16px 18px 0" }}><h2>Holdings</h2><span className="muted" style={{ fontSize: 12.5 }}>{data.holdings.length} position{data.holdings.length === 1 ? "" : "s"}</span></div>
              {data.holdings.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Stock</th><th className="l">Sector</th><th>Qty</th><th>Avg price</th><th>Last</th><th>Market value</th><th>Weight</th>
                        <th>Gross P/L</th><th>Gross %</th><th>Net P/L est.</th></tr>
                    </thead>
                    <tbody>
                      {data.holdings.map((h: any) => <HoldingRow key={h.symbol} h={h} />)}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="empty center">No holdings yet.<br />Open a stock from <Link href="/market">Market</Link> and record a simulated buy.</div>
              )}
              <p className="muted" style={{ fontSize: 12, padding: "10px 18px 14px", margin: 0 }}>
                Net P/L est. = gross P/L − buy fees on the remaining shares − the fees you would pay to sell at the last price.
              </p>
            </div>

            <div className="grid cols-2 section">
              <div className="card"><h2>Allocation by stock</h2>
                <Allocation cashWeight={data.cash_weight_pct ?? 0} parts={data.holdings.map((h: any) => ({ name: h.symbol, weight: h.weight_pct, value: h.market_value }))} /></div>
              <div className="card"><h2>Allocation by sector</h2>
                <Allocation cashWeight={data.cash_weight_pct ?? 0} parts={data.sector_allocation.map((r: any) => ({ name: r.sector, weight: r.weight_pct, value: r.market_value }))} /></div>
            </div>

            <div className="card section">
              <h2>Performance over time</h2>
              {hist.curve.length > 1 ? (
                <>
                  <LinesChart series={[
                    { name: "Portfolio value (before exit fees)", points: hist.curve },
                    ...(hist.benchmark ? [{ name: `${hist.benchmark.symbol} rebased${hist.benchmark.source === "sample" ? " (sample)" : ""}`, points: hist.benchmark.curve }] : []),
                  ]} />
                  <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Starts on the first trade date. The benchmark is rebased to the portfolio value on that day.</p>
                </>
              ) : (
                <div className="empty center">The chart appears once there is at least one trade and two sessions of data after it.</div>
              )}
            </div>
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Return on starting capital: gross {pct(s.return_gross_pct)}, net {pct(s.return_net_pct)}.</p>
          </>
        )}
      </State>
    </>
  );
}
