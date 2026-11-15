"use client";
import Link from "next/link";
import { Fragment, useState } from "react";
import { download } from "@/lib/api";
import { egp, int, num, price, tone } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import TradeTicket from "@/components/TradeTicket";
import { Kpi, Profit, State } from "@/components/ui";

export default function Trades() {
  const { data, loading, error, reload } = useApi("/api/v1/trades");
  const stocks = useApi("/api/v1/stocks");
  const [type, setType] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [symbol, setSymbol] = useState("");
  const t = data?.totals;
  const rows = (data?.transactions ?? []).filter((r: any) => !type || r.type === type);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Trades &amp; Transactions</h1>
          <p className="sub">Append-only ledger of every simulated buy and sell, with its fees. Entries are never edited or deleted.</p>
        </div>
        <button onClick={() => download("/api/v1/trades/export.csv", "egx-paper-trades.csv").catch((e) => alert(e.message))}>Export CSV</button>
      </div>
      <State loading={loading} error={error}>
        {t && (
          <>
            <div className="grid cols-4">
              <Kpi label="Buys (gross)" value={egp(t.buys_gross)} />
              <Kpi label="Sales (gross)" value={egp(t.sells_gross)} />
              <Kpi label="Fees paid" value={egp(t.fees_paid)} hint={`${t.count} trade${t.count === 1 ? "" : "s"}`} />
              <Profit label="Realized profit / loss" gross={t.realized_gross} net={t.realized_net} />
            </div>

            <div className="grid cols-2 section">
              <div className="card">
                <h2>New simulated order</h2>
                <div className="field">
                  <label htmlFor="tr-sym">Stock</label>
                  <select id="tr-sym" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
                    <option value="">Select a stock…</option>
                    {stocks.data?.map((s: any) => <option key={s.symbol} value={s.symbol}>{s.symbol} — {s.name} ({price(s.last)})</option>)}
                  </select>
                </div>
                {symbol ? <TradeTicket key={symbol} symbol={symbol} onDone={reload} /> : <div className="empty">Choose a stock to see the fee preview.</div>}
              </div>
              <div className="card">
                <h2>How profit is calculated</h2>
                <dl className="kv">
                  <dt>Gross profit</dt><dd>(sell price − average cost) × quantity</dd>
                  <dt>Net realized</dt><dd>gross − buy fees for those shares − sell fees</dd>
                  <dt>Average cost</dt><dd>weighted buy price, fees excluded</dd>
                  <dt>Fill price</dt><dd>the stock&apos;s latest price</dd>
                  <dt>Trade date</dt><dd>the market&apos;s current session</dd>
                </dl>
                <p className="muted" style={{ marginTop: 12 }}>
                  Fees come from the schedule in <Link href="/settings">Settings</Link> at the moment of each trade and are stored with it, so later changes to the schedule never rewrite history.
                </p>
              </div>
            </div>

            <div className="card flush section">
              <div className="toolbar" style={{ justifyContent: "space-between", padding: "14px 18px 0" }}>
                <h2 style={{ margin: 0 }}>Ledger <span className="muted" style={{ fontWeight: 500 }}>· {rows.length} entries</span></h2>
                <select aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">All types</option><option>BUY</option><option>SELL</option><option>DEPOSIT</option>
                </select>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>#</th><th>Trade date</th><th className="l">Type</th><th className="l">Stock</th><th>Qty</th><th>Price</th><th>Gross value</th><th>Fees</th>
                      <th>Cash movement</th><th>Gross profit</th><th>Net profit</th><th>Left</th><th>Cash after</th><th>&nbsp;</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((r: any) => (
                      <Fragment key={r.seq}>
                        <tr>
                          <td>{r.seq}</td><td>{r.trade_date ?? r.ts.slice(0, 10)}</td>
                          <td className={`l ${r.type === "BUY" ? "up" : r.type === "SELL" ? "down" : ""}`}><strong>{r.type}</strong>{String(r.origin ?? "").startsWith("strategy:") && <span className="badge" title="Placed by an automatic paper-trading run" style={{ marginLeft: 6 }}>auto</span>}
                            {r.backdated && <span className="badge warn" title="Entered afterwards at a past day's close, with later prices already known" style={{ marginLeft: 6 }}>back-dated</span>}</td>
                          <td className="l">{r.symbol ? <Link href={`/stock?symbol=${r.symbol}`}><strong>{r.symbol}</strong></Link> : "—"}</td>
                          <td>{r.qty ? int(r.qty) : "—"}</td><td>{r.price == null ? "—" : price(r.price)}</td><td>{num(r.gross)}</td><td>{r.type === "DEPOSIT" ? "—" : num(r.fees_total)}</td>
                          <td className={tone(r.cash_delta)}>{num(r.cash_delta)}</td>
                          <td className={tone(r.realized_gross)}>{r.realized_gross == null ? "—" : num(r.realized_gross)}</td>
                          <td className={tone(r.realized_net)}>{r.realized_net == null ? "—" : num(r.realized_net)}</td>
                          <td>{r.remaining_qty == null ? "—" : int(r.remaining_qty)}</td><td>{num(r.cash_after)}</td>
                          <td>{r.type !== "DEPOSIT" && <button className="small" aria-expanded={open === r.seq} onClick={() => setOpen(open === r.seq ? null : r.seq)}>Details</button>}</td>
                        </tr>
                        {open === r.seq && (
                          <tr>
                            <td colSpan={14} className="l wrap" style={{ background: "var(--panel-2)" }}>
                              <div className="grid cols-3">
                                <dl className="kv">
                                  <dt>Gross value</dt><dd>{egp(r.gross)}</dd>
                                  {r.fees.map((f: any) => <div key={f.code} style={{ display: "contents" }}><dt>{f.name}</dt><dd>{num(f.amount)}</dd></div>)}
                                  <dt className="total">{r.type === "BUY" ? "Total cash paid" : "Net cash received"}</dt><dd className="total">{egp(Math.abs(r.cash_delta))}</dd>
                                </dl>
                                {r.type === "SELL" && (
                                  <dl className="kv">
                                    <dt>Average cost</dt><dd>{price(r.avg_cost)}</dd>
                                    <dt>Gross profit</dt><dd>{egp(r.realized_gross)}</dd>
                                    <dt>Buy fees for these shares</dt><dd>−{num(r.buy_fees_allocated)}</dd>
                                    <dt>Sell fees</dt><dd>−{num(r.fees_total)}</dd>
                                    <dt className="total">Net profit</dt><dd className="total">{egp(r.realized_net)}</dd>
                                  </dl>
                                )}
                                <div>
                                  <div className="muted">Recorded {r.ts} · price source: {r.price_source ?? "—"}{r.price_date && r.price_date !== r.trade_date ? ` · price of ${r.price_date}` : ""}{r.fees_verified === false ? " · fee schedule unverified at the time" : ""}</div>
                                  <div style={{ marginTop: 6 }}>{r.note || <span className="muted">No note.</span>}</div>
                                  <div style={{ marginTop: 8 }}><Link className="btn small" href={`/journal?symbol=${r.symbol}&trade=${r.seq}&date=${r.trade_date}`}>Write a journal entry for this trade</Link></div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </State>
    </>
  );
}
