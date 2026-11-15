"use client";
import { ChevronDown, ChevronUp, Download, MousePointerClick } from "lucide-react";
import Link from "next/link";
import { Fragment, useState } from "react";
import { download } from "@/lib/api";
import { egp, int, num, price, tone } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import TradeTicket from "@/components/TradeTicket";
import { Empty, Kpi, Profit, State } from "@/components/ui";

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
        <button onClick={() => download("/api/v1/trades/export.csv", "egx-paper-trades.csv").catch((e) => alert(e.message))}><Download size={15} aria-hidden="true" />Export CSV</button>
      </div>
      <State loading={loading} error={error}>
        {t && (
          <>
            <div className="statband four">
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
                {symbol ? <TradeTicket key={symbol} symbol={symbol} onDone={reload} />
                  : <Empty icon={MousePointerClick} title="Choose a stock">The ticket shows the fill price and every fee before anything is recorded.</Empty>}
              </div>
              <div className="card">
                <h2>How profit is calculated</h2>
                <dl className="kv ruled">
                  <dt>Gross profit</dt><dd>(sell price − average cost) × quantity</dd>
                  <dt>Net realized</dt><dd>gross − buy fees for those shares − sell fees</dd>
                  <dt>Average cost</dt><dd>weighted buy price, fees excluded</dd>
                  <dt>Fill price</dt><dd>the stock&apos;s latest price</dd>
                  <dt>Trade date</dt><dd>the market&apos;s current session</dd>
                </dl>
                <p className="foot-note" style={{ marginTop: 14 }}>
                  Fees come from the schedule in <Link href="/settings">Settings</Link> at the moment of each trade and are stored with it, so later changes to the schedule never rewrite history.
                </p>
              </div>
            </div>

            <div className="card flush section">
              <div className="card-head">
                <h2>Ledger<span className="count">{rows.length} {rows.length === 1 ? "entry" : "entries"}</span></h2>
                <select aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value)} style={{ width: "auto", minWidth: 150, height: 32 }}>
                  <option value="">All types</option><option value="BUY">Buys</option><option value="SELL">Sells</option><option value="DEPOSIT">Deposits</option>
                </select>
              </div>
              <div className="table-wrap">
                <table className="dense">
                  <thead>
                    <tr><th>#</th><th className="l">Date</th><th className="l">Type</th><th className="l">Stock</th><th>Qty</th><th>Price</th><th>Value</th><th>Fees</th>
                      <th>Cash flow</th><th>Gross P/L</th><th>Net P/L</th><th className="col-wide" title="Shares still held after this trade">Left</th><th title="Cash balance after this entry">Balance</th>
                      <th><span className="sr-only">Details</span></th></tr>
                  </thead>
                  <tbody>
                    {rows.map((r: any) => (
                      <Fragment key={r.seq}>
                        <tr>
                          <td className="muted">{r.seq}</td><td className="l">{r.trade_date ?? r.ts.slice(0, 10)}</td>
                          <td className="l"><span className={`badge leg ${r.type === "BUY" ? "ok" : r.type === "SELL" ? "bad" : ""}`}>{r.type === "DEPOSIT" ? "Deposit" : r.type === "BUY" ? "Buy" : "Sell"}</span>
                            {String(r.origin ?? "").startsWith("strategy:") && <span className="badge" title="Placed by an automatic paper-trading run" style={{ marginLeft: 6 }}>auto</span>}
                            {r.origin === "assistant" && <span className="badge paper" title="Placed by the assistant" style={{ marginLeft: 6 }}>assistant</span>}
                            {String(r.origin ?? "").startsWith("order:") && <span className="badge" title="A stop-loss or take-profit order carried out by the app" style={{ marginLeft: 6 }}>order</span>}
                            {r.backdated && <span className="badge warn" title="Entered afterwards at a past day's close, with later prices already known" style={{ marginLeft: 6 }}>back-dated</span>}</td>
                          <td className="l">{r.symbol ? <Link href={`/stock?symbol=${r.symbol}`}><strong>{r.symbol}</strong></Link> : "—"}</td>
                          <td>{r.qty ? int(r.qty) : "—"}</td><td>{r.price == null ? "—" : price(r.price)}</td><td>{num(r.gross)}</td><td>{r.type === "DEPOSIT" ? "—" : num(r.fees_total)}</td>
                          <td className={tone(r.cash_delta)}>{num(r.cash_delta)}</td>
                          <td className={tone(r.realized_gross)}>{r.realized_gross == null ? "—" : num(r.realized_gross)}</td>
                          <td className={tone(r.realized_net)}>{r.realized_net == null ? "—" : num(r.realized_net)}</td>
                          <td className="col-wide">{r.remaining_qty == null ? "—" : int(r.remaining_qty)}</td><td>{num(r.cash_after)}</td>
                          <td>{r.type !== "DEPOSIT" && (
                            <button className="icon-btn ghost small" aria-expanded={open === r.seq} aria-label={`${open === r.seq ? "Hide" : "Show"} the details of entry ${r.seq}`}
                              title="Fee breakdown and note" onClick={() => setOpen(open === r.seq ? null : r.seq)}>
                              {open === r.seq ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                            </button>
                          )}</td>
                        </tr>
                        {open === r.seq && (
                          <tr className="detail">
                            <td colSpan={14} className="l wrap">
                              <div className="grid cols-3">
                                <dl className="kv">
                                  <dt>Gross value</dt><dd>{egp(r.gross)}</dd>
                                  {r.fees.map((f: any) => <Fragment key={f.code}><dt>{f.name}</dt><dd>{num(f.amount)}</dd></Fragment>)}
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
                                  <div className="muted" style={{ fontSize: 12 }}>Recorded {String(r.ts).slice(0, 16).replace("T", " ")} UTC · price source: {r.price_source ?? "—"}{r.price_date && r.price_date !== r.trade_date ? ` · price of ${r.price_date}` : ""}{r.fees_verified === false ? " · fee schedule unverified at the time" : ""}</div>
                                  <div style={{ marginTop: 8 }}>{r.note || <span className="muted">No note.</span>}</div>
                                  <div style={{ marginTop: 10 }}><Link className="btn small" href={`/journal?symbol=${r.symbol}&trade=${r.seq}&date=${r.trade_date}`}>Write a journal entry for this trade</Link></div>
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
