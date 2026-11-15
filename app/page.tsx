"use client";
import Link from "next/link";
import { useMemo } from "react";
import { big, egp, num, pct } from "@/lib/format";
import { useLiveState } from "@/lib/live";
import { useApi } from "@/lib/useApi";
import { LiveChg, LiveIndex, LiveLast, LiveVolume } from "@/components/LiveCells";
import { Chg, Kpi, Profit, Spark, State } from "@/components/ui";

/** While prices are streaming, the three lists are ranked again in the browser on every tick. */
function useLiveMovers(server: any) {
  const { state, version, quotes } = useLiveState();
  return useMemo(() => {
    // wait until the stream has delivered a fair share of the market before ranking from it
    const enough = Math.min(10, server?.breadth?.covered ?? 10);
    if (state !== "live" || quotes.size < enough || !server?.gainers) return { ...server, streaming: false };
    const rows = Array.from(quotes, ([symbol, [last, change_pct, volume]]) => ({ symbol, last, change_pct, volume }));
    const moved = rows.filter((r) => r.change_pct != null);
    const by = (key: "change_pct" | "volume", dir: 1 | -1) => [...moved].sort((a, b) => dir * ((b[key] ?? 0) - (a[key] ?? 0))).slice(0, 5);
    return {
      ...server, streaming: true,
      gainers: by("change_pct", 1).filter((r) => (r.change_pct ?? 0) > 0),
      losers: by("change_pct", -1).filter((r) => (r.change_pct ?? 0) < 0),
      most_active: by("volume", 1),
      live_breadth: { up: moved.filter((r) => r.change_pct! > 0).length, down: moved.filter((r) => r.change_pct! < 0).length,
                      flat: moved.filter((r) => r.change_pct === 0).length },
    };
  }, [state, version, server]); // eslint-disable-line react-hooks/exhaustive-deps
}

function Movers({ title, rows }: { title: string; rows: any[] }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="table-wrap">
        <table>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol}>
                <td><Link href={`/stock?symbol=${r.symbol}`}><strong>{r.symbol}</strong></Link></td>
                <td><LiveLast symbol={r.symbol} last={r.last} /></td>
                <td><LiveChg symbol={r.symbol} value={r.change_pct} /></td>
                <td className="muted"><LiveVolume symbol={r.symbol} value={r.volume} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const ov = useApi("/api/v1/market/overview");
  const pf = useApi("/api/v1/portfolio");
  const wl = useApi("/api/v1/watchlist");
  const sg = useApi("/api/v1/signals");
  const st = useApi("/api/v1/status");
  const s = pf.data?.summary;
  const b = ov.data?.breadth;
  const mv = useLiveMovers(ov.data);
  const d = st.data?.data;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="sub">What is happening in the market, and how is the paper portfolio performing?</p>
        </div>
        {ov.data?.as_of && (
          <span className="badge">
            {mv.streaming
              ? "● Live · streaming, prices move as trades happen"
              : d?.is_live
                ? `Live prices · ${String(d.live_as_of).slice(11, 16)} Cairo · updated every 15 seconds while the market is open`
                : `Market data as of ${ov.data.as_of} · end of day, not live`}
          </span>
        )}
      </div>

      <State loading={ov.loading} error={ov.error}>
        {ov.data && (
          <>
            <div className="grid cols-4">
              {ov.data.indices.length === 0 && (
                <div className="card kpi">
                  <div className="label">EGX indices</div>
                  <div className="hint" style={{ marginTop: 8 }}>Not provided by the current data feed. No index figures are shown in their place.</div>
                </div>
              )}
              {ov.data.indices.map((i: any) => (
                <div className="card kpi" key={i.symbol}>
                  <div className="label">{i.symbol}{i.source === "sample" ? " · sample" : i.source === "younit" ? (i.live ? " · live" : ` · ${i.as_of}`) : ""}</div>
                  {i.source === "younit" ? <LiveIndex name={i.symbol} last={i.last} changePct={i.change_pct} /> : (
                    <>
                      <div className="value">{num(i.last)}</div>
                      <div className="hint"><Chg v={i.change_pct} /> <Spark data={i.spark} /></div>
                    </>
                  )}
                </div>
              ))}
              {b && (
                <div className="card kpi">
                  <div className="label">Market breadth ({b.covered} stocks covered)</div>
                  <div className="value">
                    <span className="up">{mv.live_breadth?.up ?? b.advancers}</span> / <span className="down">{mv.live_breadth?.down ?? b.decliners}</span> / <span className="flat">{mv.live_breadth?.flat ?? b.unchanged}</span>
                  </div>
                  <div className="hint">Up / down / unchanged · volume {big(b.volume)} · turnover ≈ EGP {big(b.turnover_approx)}</div>
                </div>
              )}
            </div>
          </>
        )}
      </State>

      <h3 className="section">Paper portfolio</h3>
      <State loading={pf.loading} error={pf.error}>
        {s && (
          <div className="grid cols-4">
            <Kpi label="Portfolio value" value={egp(s.total_value)} hint={`Started with ${egp(s.starting_capital)}`} />
            <Kpi label="Available cash" value={egp(s.cash)} hint={`Fees paid so far ${egp(s.fees_paid)}`} />
            <Profit label="Realized profit / loss" gross={s.realized_gross} net={s.realized_net} />
            <Profit label="Unrealized profit / loss" gross={s.unrealized_gross} net={s.unrealized_net_est} netLabel="Net est. after exit fees" />
            <Profit label="Total profit / loss" gross={s.total_gross} net={s.total_net} pctNet={s.return_net_pct} />
          </div>
        )}
      </State>
      {s && !s.fees_verified && (
        <p className="muted" style={{ marginTop: 8 }}>
          Net figures use an unverified fee schedule. <Link href="/settings">Check it against your broker tariff</Link>.
        </p>
      )}

      {ov.data?.gainers && (
        <div className="grid cols-3 section">
          <Movers title="Top gainers" rows={mv.gainers} />
          <Movers title="Top losers" rows={mv.losers} />
          <Movers title="Highest volume" rows={mv.most_active} />
        </div>
      )}

      <div className="grid cols-3 section">
        <div className="card">
          <h2>Watchlist</h2>
          {wl.data?.length ? (
            <div className="table-wrap">
              <table>
                <tbody>
                  {wl.data.map((r: any) => (
                    <tr key={r.symbol}>
                      <td><Link href={`/stock?symbol=${r.symbol}`}><strong>{r.symbol}</strong></Link></td>
                      <td><LiveLast symbol={r.symbol} last={r.last} /></td>
                      <td><LiveChg symbol={r.symbol} value={r.change_pct} /></td>
                      <td><Spark data={r.spark} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">Nothing watched yet. Add stocks from <Link href="/market">Market</Link>.</div>
          )}
        </div>
        <div className="card">
          <h2>Active strategy signals</h2>
          {sg.data?.length ? (
            <div className="table-wrap">
              <table>
                <tbody>
                  {sg.data.slice(0, 8).map((r: any) => (
                    <tr key={r.strategy_id + r.symbol}>
                      <td><Link href={`/stock?symbol=${r.symbol}`}><strong>{r.symbol}</strong></Link></td>
                      <td className="l">{r.strategy}</td>
                      <td className={r.signal === "entry" ? "up" : "down"}>{r.signal}</td>
                      <td className="muted">{r.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty">
              No signals on the latest bar. Signals come from strategies you save in <Link href="/strategies">Strategy Management</Link>.
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>Signals are informational. They never place orders.</p>
        </div>
        <div className="card">
          <h2>Data connection status</h2>
          {d && (
            <dl className="kv">
              <dt>Price data</dt><dd>{d.mode === "sample" ? "Sample (synthetic)" : d.mode === "mixed" ? "Imported + sample" : d.mode === "imported" ? "Imported CSV" : d.mode === "younit" ? "Younit, daily bars" : "None"}</dd>
              <dt>Latest bar</dt><dd>{d.latest_bar_date ?? "—"}</dd>
              <dt>Sessions behind today</dt><dd>{d.trading_days_behind ?? "—"}</dd>
              <dt>Live prices</dt><dd>{d.is_live ? `On, ${d.live_symbols} stocks, ${String(d.live_as_of).slice(11, 16)} Cairo` : st.data?.provider?.market_open ? "Waiting for the feed" : "Market closed"}</dd>
              <dt>Younit market data</dt><dd>{st.data?.provider?.configured ? "Connected, read-only" : "Not connected"}</dd>
              <dt>Live order execution</dt><dd>Disabled</dd>
              <dt>News feed</dt><dd>Later phase</dd>
              <dt>Stocks missing data</dt><dd>{d.symbols_without_data.length}</dd>
              <dt>Stocks behind latest date</dt><dd>{d.symbols_behind_latest.length}</dd>
            </dl>
          )}
          {b?.avg_change_pct != null && <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>Average stock move today: {pct(b.avg_change_pct)}</p>}
        </div>
      </div>
    </>
  );
}
