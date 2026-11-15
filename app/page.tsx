"use client";
import { Activity, Newspaper, Star } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { big, egp, int, num, tone } from "@/lib/format";
import { useLiveState } from "@/lib/live";
import { useApi } from "@/lib/useApi";
import { LinesChart } from "@/components/Charts";
import { LiveChg, LiveIndex, LiveLast, LiveVolume } from "@/components/LiveCells";
import { CardHead, Chg, Delta, Empty, Skeleton, Spark, State } from "@/components/ui";

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

function Movers({ title, rows, empty }: { title: string; rows?: any[]; empty: string }) {
  return (
    <div className="card flush">
      <div className="card-head"><h2>{title}</h2><Link className="more" href="/market">All stocks</Link></div>
      {!rows ? <div style={{ padding: "0 18px 16px" }}><Skeleton lines={5} /></div> : rows.length === 0 ? <div className="empty center">{empty}</div> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Stock</th><th>Last</th><th>Day</th><th>Volume</th></tr></thead>
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
      )}
    </div>
  );
}

export default function Dashboard() {
  const ov = useApi("/api/v1/market/overview");
  const pf = useApi("/api/v1/portfolio");
  const wl = useApi("/api/v1/watchlist");
  const sg = useApi("/api/v1/signals");
  const st = useApi("/api/v1/status");
  const news = useApi("/api/v1/research");
  const s = pf.data?.summary;
  const b = ov.data?.breadth;
  const d = st.data?.data;
  const mv = useLiveMovers(ov.data);
  const curve = pf.data?.history?.curve ?? [];
  const up = mv.live_breadth?.up ?? b?.advancers ?? 0, down = mv.live_breadth?.down ?? b?.decliners ?? 0, flat = mv.live_breadth?.flat ?? b?.unchanged ?? 0;
  const moving = up + down + flat || 1;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p className="sub">What the market is doing, and how the paper portfolio is performing.</p>
        </div>
        {ov.data?.as_of && (
          <span className={`pill ${mv.streaming ? "live" : ""}`}>
            {mv.streaming ? <><span className="dot" />Live · streaming, prices move as trades happen</>
              : d?.is_live ? `Live prices · ${String(d.live_as_of).slice(11, 16)} Cairo · refreshed every 15 seconds`
              : `Close of ${ov.data.as_of} · not live`}
          </span>
        )}
      </div>

      <div className="dash-top">
        {/* the one hero figure of this view */}
        <div className="card">
          <State loading={pf.loading} error={pf.error} skeleton={<Skeleton lines={5} height={18} />}>
            {s && (
              <>
                <div className="card-head" style={{ marginBottom: 0 }}>
                  <h3 style={{ margin: 0 }}>Paper portfolio value</h3>
                  <Link className="more" href="/portfolio">Open portfolio</Link>
                </div>
                <div className="hero-value"><small>EGP</small>{s.total_value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <Delta v={s.return_net_pct} />
                  <span className={`num ${tone(s.total_net)}`} style={{ fontWeight: 620 }}>{egp(s.total_net)}</span>
                  <span className="muted">net of all fees, on {egp(s.starting_capital)} starting capital</span>
                </div>
                {curve.length > 1 ? (
                  <div style={{ marginTop: 14 }}><LinesChart height={190} series={[{ name: "Portfolio value", points: curve }]} /></div>
                ) : (
                  <p className="foot-note" style={{ marginTop: 14 }}>
                    The value chart appears after the first simulated trade. Open any stock from <Link href="/market">Market</Link> to place one.
                  </p>
                )}
                <div className="stats ruled" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))", gap: "14px 16px" }}>
                  <div><div className="k">Cash</div><div className="v">{num(s.cash)}</div></div>
                  <div><div className="k">Invested, at market</div><div className="v">{num(s.market_value)}</div></div>
                  <div><div className="k">Realized, net</div><div className={`v ${tone(s.realized_net)}`}>{num(s.realized_net)}</div><div className="s">gross {num(s.realized_gross)}</div></div>
                  <div><div className="k">Unrealized, net est.</div><div className={`v ${tone(s.unrealized_net_est)}`}>{num(s.unrealized_net_est)}</div><div className="s">gross {num(s.unrealized_gross)}</div></div>
                  <div><div className="k">Fees paid</div><div className="v">{num(s.fees_paid)}</div></div>
                </div>
                <p className="foot-note">
                  Amounts in EGP.{!s.fees_verified && (
                    <> Net figures use a placeholder fee schedule: <Link href="/settings">enter your broker&apos;s tariff</Link> to make them exact.</>
                  )}
                </p>
              </>
            )}
          </State>
        </div>

        <div className="card">
          <CardHead title="Market"><Link className="more" href="/market">Market map</Link></CardHead>
          <State loading={ov.loading} error={ov.error} skeleton={<Skeleton lines={6} />}>
            {ov.data && (
              <>
                {ov.data.indices.length === 0 ? (
                  <p className="muted" style={{ fontSize: 12.5 }}>Index levels are not available from the data feed yet. No figures are shown in their place.</p>
                ) : (
                  <div>
                    {ov.data.indices.slice(0, 4).map((i: any) => (
                      <div className="idx" key={i.symbol}>
                        <div className="n">{i.symbol}{i.source === "sample" && <small>sample</small>}</div>
                        <Spark data={i.spark} width={72} height={24} />
                        <LiveIndex name={i.symbol} last={i.last} changePct={i.change_pct} />
                      </div>
                    ))}
                  </div>
                )}
                {b && (
                  <>
                    <h3 style={{ marginTop: 16 }}>Breadth · {b.covered} stocks</h3>
                    <div className="breadth" role="img" aria-label={`${up} stocks up, ${flat} unchanged, ${down} down`}>
                      <span style={{ width: `${(up / moving) * 100}%`, background: "var(--up)" }} />
                      <span style={{ width: `${(flat / moving) * 100}%`, background: "var(--border-strong)" }} />
                      <span style={{ width: `${(down / moving) * 100}%`, background: "var(--down)" }} />
                    </div>
                    <div className="num" style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                      <span className="up">▲ {int(up)} up</span><span className="muted">{int(flat)} flat</span><span className="down">▼ {int(down)} down</span>
                    </div>
                    <dl className="kv ruled" style={{ marginTop: 16 }}>
                      <dt>Average move today</dt><dd><Chg v={b.avg_change_pct} /></dd>
                      <dt>Shares traded</dt><dd>{big(b.volume)}</dd>
                      <dt>Value traded (approx.)</dt><dd>EGP {big(b.turnover_approx)}</dd>
                    </dl>
                  </>
                )}
              </>
            )}
          </State>
        </div>
      </div>

      <div className="grid cols-3 section">
        <Movers title="Top gainers" rows={mv.gainers} empty="No stock is up today." />
        <Movers title="Top losers" rows={mv.losers} empty="No stock is down today." />
        <Movers title="Most active" rows={mv.most_active} empty="No trading yet." />
      </div>

      <div className="grid cols-3 section">
        <div className="card flush">
          <div className="card-head"><h2>Watchlist</h2><Link className="more" href="/watchlist">Manage</Link></div>
          {wl.data?.length ? (
            <div className="table-wrap">
              <table>
                <tbody>
                  {wl.data.slice(0, 8).map((r: any) => (
                    <tr key={r.symbol}>
                      <td><div className="sym"><Link href={`/stock?symbol=${r.symbol}`}>{r.symbol}</Link><span style={{ maxWidth: 150 }} title={r.name}>{r.name}</span></div></td>
                      <td className="col-wide"><Spark data={r.spark} width={64} height={24} /></td>
                      <td><div className="cell2"><strong style={{ fontWeight: 620 }}><LiveLast symbol={r.symbol} last={r.last} /></strong><small><LiveChg symbol={r.symbol} value={r.change_pct} /></small></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={Star} title="Nothing watched yet">Star a stock in <Link href="/market">Market</Link> to follow it here.</Empty>
          )}
        </div>

        <div className="card flush">
          <div className="card-head"><h2>Strategy signals</h2><Link className="more" href="/strategies">Strategies</Link></div>
          {sg.data?.length ? (
            <div className="table-wrap">
              <table>
                <tbody>
                  {sg.data.slice(0, 8).map((r: any) => (
                    <tr key={r.strategy_id + r.symbol}>
                      <td><div className="sym"><Link href={`/stock?symbol=${r.symbol}`}>{r.symbol}</Link><span>{r.strategy}</span></div></td>
                      <td><div className="cell2"><span className={`badge ${r.signal === "entry" ? "ok" : "bad"}`}>{r.signal === "entry" ? "▲ entry" : "▼ exit"}</span>
                        <small className="muted" style={{ marginTop: 3 }}>{r.date}</small></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={Activity} title="No signal on the latest session">Signals come from your saved strategies and never place orders.</Empty>
          )}
        </div>

        <div className="card flush">
          <div className="card-head"><h2>Research &amp; news</h2><Link className="more" href="/research">Library</Link></div>
          {news.data?.length ? (
            <div className="table-wrap">
              <table>
                <tbody>
                  {news.data.slice(0, 6).map((n: any) => (
                    <tr key={n.id}>
                      <td className="wrap">{n.url ? <a href={n.url} target="_blank" rel="noopener noreferrer nofollow">{n.title} ↗</a> : n.title}
                        <span className="sub2">{n.published ?? n.created_at.slice(0, 10)}{n.symbols.length ? ` · ${n.symbols.join(", ")}` : ""}{n.verified ? "" : " · not verified"}</span></td>
                      <td><span className={`badge ${n.sentiment === "positive" ? "ok" : n.sentiment === "negative" ? "bad" : ""}`}>{n.sentiment}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty icon={Newspaper} title="Your library is empty">Save links and notes in <Link href="/research">Research &amp; News</Link>.</Empty>
          )}
        </div>
      </div>
    </>
  );
}
