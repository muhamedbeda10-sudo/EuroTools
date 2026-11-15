"use client";
import { Bell, CandlestickChart, Newspaper, NotebookPen, Star } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, useState } from "react";
import { api } from "@/lib/api";
import { big, int, num, pct, price, signed, tone } from "@/lib/format";
import { Flash } from "@/lib/live";
import { useApi } from "@/lib/useApi";
import { useStockStream } from "@/lib/useStockStream";
import { MacdChart, PriceChart, RsiChart, SMA_VARS, type Pattern } from "@/components/Charts";
import PriceDepth from "@/components/PriceDepth";
import { ResearchItem } from "@/components/ResearchItem";
import TradeTicket from "@/components/TradeTicket";
import { CardHead, Chg, Delta, Empty, Skeleton, SourceTag, State } from "@/components/ui";

const TF = [["d", "1D"], ["w", "1W"], ["m", "1M"]] as const;
const OVERLAYS = [["sma20", "SMA 20"], ["sma50", "SMA 50"], ["sma200", "SMA 200"]] as const;

function RelatedResearch({ symbol }: { symbol: string }) {
  const { data } = useApi(`/api/v1/research?symbol=${symbol}`);
  return (
    <div className="card">
      <CardHead title="Research & news"><Link className="more" href={`/research?symbol=${symbol}`}>Add or view all</Link></CardHead>
      {data?.length ? <div className="list">{data.slice(0, 4).map((item: any) => <ResearchItem key={item.id} item={item} />)}</div>
        : <Empty icon={Newspaper} title="Nothing saved for this stock yet">Add a disclosure, a news link or your own note to keep it beside the chart.</Empty>}
    </div>
  );
}

const STATE: Record<Pattern["state"], { label: string; tone: string; hint: string }> = {
  forming: { label: "forming", tone: "warn", hint: "The candle is not complete yet; its shape can still change." },
  pending: { label: "awaiting next session", tone: "", hint: "No later session yet to confirm or reject it." },
  confirmed: { label: "confirmed", tone: "ok", hint: "The next session closed beyond the pattern, in its direction." },
  unconfirmed: { label: "not confirmed", tone: "", hint: "The next session did not close beyond the pattern." },
  failed: { label: "failed", tone: "bad", hint: "A later session closed through the level the pattern defends." },
  open: { label: "window open", tone: "ok", hint: "No close has gone back through the gap." },
};
const PERIOD = { d: "session", w: "week", m: "month" } as const;
const PATTERNS_LISTED = 8;

/** The candle patterns of the latest bars, newest first: what was seen, where it stands and the price it defends. */
function CandlePatterns({ patterns, tf }: { patterns: Pattern[]; tf: "d" | "w" | "m" }) {
  const latest = [...patterns].reverse().slice(0, PATTERNS_LISTED);
  return (
    <div className="card">
      <CardHead title="Candle patterns"><Link className="more" href="/guide#candles">How to read them</Link></CardHead>
      {latest.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th className="l">Pattern</th><th className="l">Status</th><th>Level</th></tr></thead>
            <tbody>
              {latest.map((x) => (
                <tr key={x.date + x.pattern}>
                  <td>{x.date}</td>
                  <td className="l wrap" style={{ minWidth: 170 }}>
                    <span className={`badge ${x.direction === "bullish" ? "ok" : "bad"}`} style={{ marginInlineEnd: 8 }}>{x.direction === "bullish" ? "▲ up" : "▼ down"}</span>
                    <strong style={{ fontWeight: 600 }}>{x.name}</strong>{x.volume_ratio != null && x.volume_ratio >= 1.5 ? <span className="muted"> · volume {num(x.volume_ratio)}×</span> : null}
                  </td>
                  <td className="l"><span className={`badge ${STATE[x.state].tone}`} title={STATE[x.state].hint}>{STATE[x.state].label}</span></td>
                  <td><div className="cell2"><span>{price(x.level)}</span><small className="muted">{x.level_role}</small></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty icon={CandlestickChart} title={`No candle pattern in the latest ${tf === "d" ? "sessions" : tf === "w" ? "weeks" : "months"}`} />}
      <p className="foot-note">
        Found by fixed rules on the {PERIOD[tf]} candles. A pattern is a warning that the mood may be changing, not a forecast: weigh it with the trend,
        volume and support or resistance. The level is the pattern&apos;s own low (support) or high (resistance); a close through it says the pattern failed.
      </p>
    </div>
  );
}

/** Where today's price sits between the day's low and high. */
function DayRange({ low, high, last, open }: { low?: number | null; high?: number | null; last?: number | null; open?: number | null }) {
  if (!low || !high || !last || high <= low) return null;
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - low) / (high - low)) * 100))}%`;
  return (
    <div style={{ minWidth: 220, flex: "1 1 260px", maxWidth: 380 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }} className="muted"><span>Day low</span><span>Day high</span></div>
      <div className="range" role="img" aria-label={`Day range ${price(low)} to ${price(high)}, last ${price(last)}`}>
        {open ? <span style={{ left: at(Math.min(open, last)), width: `calc(${at(Math.max(open, last))} - ${at(Math.min(open, last))})` }} /> : null}
        <i style={{ left: at(last) }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, fontVariantNumeric: "tabular-nums", fontWeight: 560 }}><span>{price(low)}</span><span>{price(high)}</span></div>
    </div>
  );
}

function StockView() {
  const symbol = (useSearchParams().get("symbol") || "").toUpperCase();
  const [tf, setTf] = useState<"d" | "w" | "m">("d");
  const [show, setShow] = useState({ sma20: true, sma50: true, sma200: false, volume: true, patterns: true });
  const { data, error, loading, reload } = useApi(symbol ? `/api/v1/stocks/${symbol}?timeframe=${tf}` : null);

  // Tick-by-tick price and order book while this page is open (feed stocks only).
  const stream = useStockStream(symbol, data?.quote?.source === "younit");
  const t = stream.state === "live" ? stream.tick?.quote : null;

  if (!symbol) return <div className="card"><Empty icon={CandlestickChart} title="No stock selected">Pick a stock from <Link href="/market">Market</Link>, or search for one above.</Empty></div>;
  const q = data?.quote, a = data?.assessment, ins = data?.instrument;
  const toggleWatch = async () => {
    await api(`/api/v1/watchlist/${symbol}`, { method: data.watched ? "DELETE" : "PUT" });
    reload();
  };
  const lastBar = data?.bars?.[data.bars.length - 1];
  const last = t?.last ?? q?.last;
  const changePct = t?.change_pct ?? q?.change_pct;
  const change = t?.change ?? q?.change;
  const day = { open: t?.open ?? (tf === "d" ? lastBar?.open : null), high: t?.high ?? (tf === "d" ? lastBar?.high : null),
                low: t?.low ?? (tf === "d" ? lastBar?.low : null) };

  return (
    <State loading={loading} error={error} skeleton={<Skeleton lines={8} height={20} />}>
      {data && (
        <>
          <div className="quote-head">
            <div style={{ minWidth: 0 }}>
              <div className="tk">
                <h1>{ins.symbol}</h1>
                <span className="badge">{ins.sector}</span>
                {t?.last && stream.open ? <span className="pill live"><span className="dot" />Live</span> : <SourceTag source={q?.source} live={q?.live} />}
              </div>
              <div className="co">{ins.name}</div>
              {data.has_data && (
                <div className="px">
                  <span className="last"><Flash value={last}>{price(last)}</Flash></span>
                  <span className="ccy">EGP</span>
                  <Delta v={changePct}>{change != null ? `${signed(change)} · ` : ""}{pct(changePct)}</Delta>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {t?.last ? (stream.open ? `updated ${stream.at?.toLocaleTimeString() ?? ""}` : "last price of the session")
                      : q.live ? `live as of ${q.as_of}` : `close of ${q.as_of}`}
                  </span>
                </div>
              )}
            </div>
            {data.has_data && <DayRange low={day.low} high={day.high} last={last} open={day.open} />}
            <div className="actions">
              <button className={data.watched ? "on" : ""} onClick={toggleWatch} aria-pressed={data.watched} disabled={!data.has_data}>
                <Star size={15} fill={data.watched ? "currentColor" : "none"} />{data.watched ? "Watching" : "Watch"}
              </button>
              <Link className="btn" href="/alerts"><Bell size={15} />Alert</Link>
              <Link className="btn" href={`/journal?symbol=${symbol}`}><NotebookPen size={15} />Journal</Link>
            </div>
          </div>

          {!data.has_data ? (
            <div className="note">No price history for this stock yet. Import a CSV in <Link href="/settings">Settings</Link>.</div>
          ) : (
            <>
              <div className="statband five tight" style={{ marginBottom: 16 }}>
                  <div><div className="k">Open</div><div className="v">{price(day.open)}</div></div>
                  <div><div className="k">Previous close</div><div className="v">{price(last != null && change != null ? last - change : null)}</div></div>
                  <div><div className="k">{t?.volume ? "Volume today" : "Volume"}</div><div className="v">{big(t?.volume ?? q.volume)}</div></div>
                  <div><div className="k">20-day avg volume</div><div className="v">{big(q.avg_volume_20)}</div></div>
                  <div><div className="k">Value traded</div><div className="v">EGP {big(t?.value ?? q.turnover)}</div></div>
                  {t?.trades ? <div><div className="k">Trades today</div><div className="v">{int(t.trades)}</div></div> : null}
                  <div><div className="k">1 week</div><div className="v"><Chg v={q.week_pct} /></div></div>
                  <div><div className="k">1 month</div><div className="v"><Chg v={q.month_pct} /></div></div>
                  {t?.trades ? null : <div><div className="k">3 months</div><div className="v"><Chg v={a.returns_pct["3m"]} /></div></div>}
                  <div><div className="k">Trend</div><div className="v" style={{ textTransform: "capitalize" }}>{a.trend}</div></div>
                  <div><div className="k">RSI (14)</div><div className="v">{num(a.rsi)}</div></div>
              </div>

              <div className="split">
                <div className="grid" style={{ minWidth: 0 }}>
                  <div className="card">
                    <div className="card-head">
                      <div className="seg" role="group" aria-label="Candle period">
                        {TF.map(([k, label]) => <button key={k} className={tf === k ? "on" : ""} aria-pressed={tf === k} onClick={() => setTf(k)}>{label}</button>)}
                      </div>
                      <div className="seg wrap" role="group" aria-label="Chart overlays">
                        {OVERLAYS.map(([k, label]) => (
                          <button key={k} className={show[k] ? "on" : ""} aria-pressed={show[k]} onClick={() => setShow({ ...show, [k]: !show[k] })}>
                            <i style={{ width: 12, height: 3, borderRadius: 2, background: SMA_VARS[k] }} />{label}
                          </button>
                        ))}
                        <button className={show.volume ? "on" : ""} aria-pressed={show.volume} onClick={() => setShow({ ...show, volume: !show.volume })}>Volume</button>
                        <button className={show.patterns ? "on" : ""} aria-pressed={show.patterns} onClick={() => setShow({ ...show, patterns: !show.patterns })}>Patterns</button>
                      </div>
                    </div>
                    <PriceChart bars={data.bars} show={show} patterns={show.patterns ? data.patterns : undefined} support={tf === "d" ? a.support : undefined} resistance={tf === "d" ? a.resistance : undefined} />
                    <p className="foot-note" style={{ marginTop: 8 }}>
                      Dashed lines mark support {price(a.support)} and resistance {price(a.resistance)}: the low and high of the last {a.window} sessions.
                      {show.patterns && data.patterns?.length ? " Arrows mark candle patterns: below the candle pointing up, above it pointing down, grey once failed; they are named in the card below." : ""}
                    </p>
                    <h3 style={{ marginTop: 20 }}>RSI (14)</h3>
                    <RsiChart bars={data.bars} />
                    <h3 style={{ marginTop: 16 }}>MACD (12, 26, 9)</h3>
                    <div className="legend"><span><i style={{ background: "var(--series-1)" }} />MACD</span><span><i style={{ background: "var(--series-2)" }} />Signal</span></div>
                    <MacdChart bars={data.bars} />
                  </div>

                  <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
                    <div className="card">
                      <CardHead title="Technical read"><span className={`badge ${a.trend === "uptrend" ? "ok" : a.trend === "downtrend" ? "bad" : ""}`}>{a.trend} · score {a.technical_score > 0 ? "+" : ""}{a.technical_score} of ±3</span></CardHead>
                      <ul className="points">{a.technical_notes.map((n: string) => <li key={n}>{n}</li>)}</ul>
                      <dl className="kv ruled" style={{ marginTop: 16 }}>
                        <dt>SMA 20 / 50 / 200</dt><dd>{num(a.sma20)} / {num(a.sma50)} / {num(a.sma200)}</dd>
                        <dt>Support / resistance</dt><dd>{price(a.support)} / {price(a.resistance)}</dd>
                      </dl>
                    </div>
                    <div className="card">
                      <CardHead title="Momentum"><span className={`badge ${a.momentum === "positive" ? "ok" : a.momentum === "negative" ? "bad" : ""}`}>{a.momentum}</span></CardHead>
                      <ul className="points">{a.momentum_notes.map((n: string) => <li key={n}>{n}</li>)}</ul>
                      <dl className="kv ruled" style={{ marginTop: 16 }}>
                        {(["1w", "1m", "3m", "6m"] as const).map((k) => (
                          <Fragment key={k}><dt>Return, {k}</dt><dd><Chg v={a.returns_pct[k]} /></dd></Fragment>
                        ))}
                        <dt>Volume vs 20-day average</dt><dd>{a.volume_ratio == null ? "—" : `${num(a.volume_ratio)}×`}</dd>
                      </dl>
                    </div>
                  </div>

                  <CandlePatterns patterns={data.patterns ?? []} tf={tf} />

                  <RelatedResearch symbol={symbol} />

                  <div className="card">
                    <CardHead title="Fundamentals" />
                    <p className="muted" style={{ margin: 0 }}>
                      {data.fundamentals.reason} Revenue, EPS, P/E, P/B, ROE, debt and dividends will appear here once a verified source is connected;
                      no estimates are shown in their place. Market cap, shares outstanding and corporate actions are not available either, so imported
                      prices are used unadjusted.
                    </p>
                  </div>
                  <p className="foot-note" style={{ margin: 0 }}>The technical, momentum and candle-pattern reads are rule-based descriptions of the price history. They are not investment advice.</p>
                </div>

                <div className="rail">
                  <div className="card">
                    <CardHead title="Simulated order"><span className="badge paper">paper</span></CardHead>
                    <TradeTicket symbol={symbol} onDone={reload} />
                  </div>
                  {q.source === "younit" && (
                    <div className="card">
                      <CardHead title="Price depth" />
                      <PriceDepth symbol={symbol} stream={stream} />
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </State>
  );
}

export default function StockPage() {
  return (
    <Suspense fallback={<Skeleton lines={6} height={20} />}>
      <StockView />
    </Suspense>
  );
}
