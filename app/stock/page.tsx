"use client";
import { Bell, NotebookPen, Star } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { big, int, num, pct, price, signed, tone } from "@/lib/format";
import { Flash } from "@/lib/live";
import { useApi } from "@/lib/useApi";
import { useStockStream } from "@/lib/useStockStream";
import { MacdChart, PriceChart, RsiChart, SMA_VARS } from "@/components/Charts";
import PriceDepth from "@/components/PriceDepth";
import { ResearchItem } from "@/components/ResearchItem";
import TradeTicket from "@/components/TradeTicket";
import { CardHead, Chg, Delta, Skeleton, SourceTag, State } from "@/components/ui";

const TF = [["d", "1D"], ["w", "1W"], ["m", "1M"]] as const;
const OVERLAYS = [["sma20", "SMA 20"], ["sma50", "SMA 50"], ["sma200", "SMA 200"]] as const;

function RelatedResearch({ symbol }: { symbol: string }) {
  const { data } = useApi(`/api/v1/research?symbol=${symbol}`);
  return (
    <div className="card">
      <CardHead title="Research & news"><Link className="more" href={`/research?symbol=${symbol}`}>Add or view all</Link></CardHead>
      {data?.length ? data.slice(0, 4).map((item: any) => <ResearchItem key={item.id} item={item} />)
        : <div className="empty">Nothing saved for this stock or its sector yet.</div>}
    </div>
  );
}

/** Where today's price sits between the day's low and high. */
function DayRange({ low, high, last, open }: { low?: number | null; high?: number | null; last?: number | null; open?: number | null }) {
  if (!low || !high || !last || high <= low) return null;
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - low) / (high - low)) * 100))}%`;
  return (
    <div style={{ minWidth: 220, flex: "1 1 260px", maxWidth: 420 }}>
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
  const [show, setShow] = useState({ sma20: true, sma50: true, sma200: false, volume: true });
  const { data, error, loading, reload } = useApi(symbol ? `/api/v1/stocks/${symbol}?timeframe=${tf}` : null);

  // Tick-by-tick price and order book while this page is open (feed stocks only).
  const stream = useStockStream(symbol, data?.quote?.source === "younit");
  const t = stream.state === "live" ? stream.tick?.quote : null;

  if (!symbol) return <div className="empty center">Pick a stock from <Link href="/market">Market</Link>, or search for one above.</div>;
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
                {t?.last ? <span className="pill live"><span className="dot" />Live</span> : <SourceTag source={q?.source} live={q?.live} />}
              </div>
              <div className="co">{ins.name}</div>
              {data.has_data && (
                <div className="px">
                  <span className="last"><Flash value={last}>{price(last)}</Flash></span>
                  <span className="ccy">EGP</span>
                  <Delta v={changePct}>{change != null ? `${signed(change)} · ` : ""}{pct(changePct)}</Delta>
                  <span className="muted" style={{ fontSize: 12.5 }}>
                    {t?.last ? `updated ${stream.at?.toLocaleTimeString() ?? ""}` : q.live ? `live as of ${q.as_of}` : `close of ${q.as_of}`}
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
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="stats">
                  <div><div className="k">Open</div><div className="v">{price(day.open)}</div></div>
                  <div><div className="k">Previous close</div><div className="v">{price(last != null && change != null ? last - change : null)}</div></div>
                  <div><div className="k">{t?.volume ? "Volume today" : "Volume"}</div><div className="v">{big(t?.volume ?? q.volume)}</div></div>
                  <div><div className="k">20-day avg volume</div><div className="v">{big(q.avg_volume_20)}</div></div>
                  <div><div className="k">Value traded</div><div className="v">EGP {big(t?.value ?? q.turnover)}</div></div>
                  {t?.trades ? <div><div className="k">Trades today</div><div className="v">{int(t.trades)}</div></div> : null}
                  <div><div className="k">1 week</div><div className="v"><Chg v={q.week_pct} /></div></div>
                  <div><div className="k">1 month</div><div className="v"><Chg v={q.month_pct} /></div></div>
                  <div><div className="k">Trend</div><div className="v" style={{ textTransform: "capitalize" }}>{a.trend}</div></div>
                  <div><div className="k">RSI (14)</div><div className="v">{num(a.rsi)}</div></div>
                </div>
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
                      </div>
                    </div>
                    <PriceChart bars={data.bars} show={show} support={tf === "d" ? a.support : undefined} resistance={tf === "d" ? a.resistance : undefined} />
                    <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                      Dashed lines mark support {price(a.support)} and resistance {price(a.resistance)}: the low and high of the last {a.window} sessions.
                    </p>
                    <h3 style={{ marginTop: 18 }}>RSI (14)</h3>
                    <RsiChart bars={data.bars} />
                    <h3 style={{ marginTop: 16 }}>MACD (12, 26, 9)</h3>
                    <div className="legend"><span><i style={{ background: "var(--series-1)" }} />MACD</span><span><i style={{ background: "var(--series-2)" }} />Signal</span></div>
                    <MacdChart bars={data.bars} />
                  </div>

                  <div className="grid cols-2">
                    <div className="card">
                      <CardHead title="Technical read"><span className={`badge ${a.trend === "uptrend" ? "ok" : a.trend === "downtrend" ? "bad" : ""}`}>{a.trend} · score {a.technical_score > 0 ? "+" : ""}{a.technical_score} of ±3</span></CardHead>
                      <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)" }}>{a.technical_notes.map((n: string) => <li key={n}>{n}</li>)}</ul>
                      <dl className="kv" style={{ marginTop: 14 }}>
                        <dt>SMA 20 / 50 / 200</dt><dd>{price(a.sma20)} / {price(a.sma50)} / {price(a.sma200)}</dd>
                        <dt>Support / resistance</dt><dd>{price(a.support)} / {price(a.resistance)}</dd>
                      </dl>
                    </div>
                    <div className="card">
                      <CardHead title="Momentum"><span className={`badge ${a.momentum === "positive" ? "ok" : a.momentum === "negative" ? "bad" : ""}`}>{a.momentum}</span></CardHead>
                      <ul style={{ margin: 0, paddingLeft: 18, color: "var(--text-2)" }}>{a.momentum_notes.map((n: string) => <li key={n}>{n}</li>)}</ul>
                      <dl className="kv" style={{ marginTop: 14 }}>
                        {(["1w", "1m", "3m", "6m"] as const).map((k) => (
                          <div key={k} style={{ display: "contents" }}><dt>Return, {k}</dt><dd><Chg v={a.returns_pct[k]} /></dd></div>
                        ))}
                        <dt>Volume vs 20-day average</dt><dd>{a.volume_ratio == null ? "—" : `${num(a.volume_ratio)}×`}</dd>
                      </dl>
                    </div>
                  </div>

                  <RelatedResearch symbol={symbol} />

                  <div className="card">
                    <CardHead title="Fundamentals" />
                    <p className="muted" style={{ margin: 0 }}>
                      {data.fundamentals.reason} Revenue, EPS, P/E, P/B, ROE, debt and dividends will appear here once a verified source is connected;
                      no estimates are shown in their place. Market cap, shares outstanding and corporate actions are not available either, so imported
                      prices are used unadjusted.
                    </p>
                  </div>
                  <p className="muted" style={{ fontSize: 12, margin: 0 }}>The technical and momentum reads are rule-based descriptions of the price history. They are not investment advice.</p>
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
