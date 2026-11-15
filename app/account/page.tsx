"use client";
import { Briefcase, CircleCheck, Landmark, RefreshCw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { egp, int, num, price, tone } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import RealOrders from "@/components/RealOrders";
import { Chg, Empty, Kpi, State } from "@/components/ui";

const PATH = "/api/v1/real-account";
const RECHECK_MS = 60 * 1000;

/** One holding as the broker reports it, next to the price the app's own feed has for the same stock. */
function HoldingRow({ h }: { h: any }) {
  return (
    <tr>
      <td>
        <div className="sym">
          {h.symbol ? <Link href={`/stock?symbol=${h.symbol}`}>{h.symbol}</Link> : <strong className="trunc" style={{ maxWidth: 200 }} title={h.name} dir="auto">{h.code ?? h.name}</strong>}
          {h.in_app ? <span title={h.name} dir="auto">{h.name}</span>
            : <span title="Not one of the stocks the app follows, such as a fund: shown at the broker's price only">{h.code ? `${h.name} · ` : ""}not in the app</span>}
          {h.suspended && <span style={{ color: "var(--down)" }} title="The broker reports trading in it as suspended">trading suspended</span>}
        </div>
      </td>
      <td className="l col-wide"><span className="muted trunc" style={{ maxWidth: 170 }} title={h.sector ?? undefined}>{h.sector ?? "—"}</span></td>
      <td>{int(h.qty)}</td>
      <td>
        <div className="cell2"><span>{int(h.available)}</span>
          {h.unsettled > 0 && <small className="muted" title="Bought but not settled yet: cannot be sold today">{int(h.unsettled)} unsettled</small>}
          {h.frozen > 0 && <small className="muted" title="Blocked by the broker">{int(h.frozen)} frozen</small>}</div>
      </td>
      <td>{price(h.avg_cost)}</td>
      <td>{price(h.price)}</td>
      <td>
        <div className="cell2"><span>{price(h.app_price)}</span>
          {h.price_differs && <small style={{ color: "var(--warn)" }} title={`The broker's price is ${num(Math.abs(h.price_gap_pct))}% ${h.price_gap_pct > 0 ? "above" : "below"} the app's`}>differs</small>}</div>
      </td>
      <td>{num(h.value)}</td>
      <td>{h.weight_pct == null ? "—" : `${num(h.weight_pct)}%`}</td>
      <td><div className="cell2"><span className={tone(h.unrealized)}>{num(h.unrealized)}</span><small><Chg v={h.unrealized_pct} /></small></div></td>
    </tr>
  );
}

/** Why the account is not on screen, in words: it is switched on per sign-in, on the server. */
function NotAvailable({ status }: { status: number | null }) {
  const me = useApi("/api/v1/status").data?.real_account;
  if (status === 404)
    return <Empty icon={Landmark} title="No brokerage connection">The real account is read through Younit, which is not connected on this server.</Empty>;
  return (
    <Empty icon={Landmark} title="Not enabled for this sign-in">
      The real brokerage account is shown only to its owner. To enable it, the owner adds this sign-in&apos;s user ID to{" "}
      <code>BROKER_ACCOUNT_UIDS</code> on the server{me?.user_id ? <>: <code>{me.user_id}</code></> : null}.
    </Empty>
  );
}

/** A link such as /account?order=COMI&side=SELL opens the page with the order ticket ready for that stock. */
function OrderFromAddress({ onStart }: { onStart: (start: { symbol: string; side?: string }) => void }) {
  const params = useSearchParams();
  const symbol = params.get("order");
  const side = params.get("side");
  useEffect(() => { if (symbol) onStart({ symbol: symbol.toUpperCase().slice(0, 12), side: side ?? undefined }); }, [symbol, side]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function RealAccount() {
  const [path, setPath] = useState(PATH);
  const [start, setStart] = useState<{ symbol: string; side?: string } | undefined>(undefined);
  const { data, loading, error, status, reload } = useApi(path);
  const refresh = () => (path === PATH ? setPath(`${PATH}?fresh=true`) : reload());

  // While the market is open and the tab is in view, read the account again once a minute.
  const open = useRef(false);
  open.current = !!data?.market_open;
  useEffect(() => {
    const timer = setInterval(() => { if (open.current && document.visibilityState === "visible") reload(); }, RECHECK_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const s = data?.summary;
  const refused = status === 403 || status === 404;
  const gain = s ? (s.unrealized ?? (s.held_value != null && s.cost ? s.held_value - s.cost : null)) : null;
  const gainPct = s ? (s.unrealized_pct ?? (gain != null && s.cost ? (gain / s.cost) * 100 : null)) : null;
  const failed = data?.checks.filter((c: any) => !c.ok).length ?? 0;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Real account <span className="badge warn" style={{ verticalAlign: "middle" }}>real money</span></h1>
          <p className="sub">Your brokerage account at EFG Hermes, as the broker reports it. An order leaves the app only when you approve that order here.</p>
        </div>
        {data && (
          <div className="actions">
            <span className="muted num" style={{ fontSize: 12.5 }}>As of {String(data.as_of).slice(11, 16)} Cairo</span>
            <button onClick={refresh} disabled={loading}><RefreshCw size={14} aria-hidden="true" /> {loading ? "Reading…" : "Refresh"}</button>
          </div>
        )}
      </div>
      <Suspense fallback={null}><OrderFromAddress onStart={setStart} /></Suspense>
      {refused ? <NotAvailable status={status} /> : (
        <State loading={loading} error={s ? null : error}>
          {s && error && <div className="note" role="status">The last refresh failed, so these are the figures from {String(data.as_of).slice(11, 16)} Cairo. {error}</div>}
          {s && (
            <>
              {data.holder?.name && (
                <p className="muted" style={{ margin: "-8px 0 14px", fontSize: 12.5 }}>
                  Account of <strong dir="auto" style={{ color: "var(--text-2)" }}>{data.holder.name}</strong>
                  {data.holder.account ? <> · <span className="num">{data.holder.account}</span></> : null}
                </p>
              )}
              <div className="statband four">
                <Kpi label="Total value" value={egp(s.total)} hint="cash plus holdings, as the broker states it" />
                <Kpi label="Cash" value={egp(s.cash)} hint={s.cash_weight_pct == null ? undefined : `${num(s.cash_weight_pct)}% of the account`} />
                <Kpi label="Holdings" value={egp(s.stocks ?? s.held_value)} hint={`Cost ${egp(s.cost)}`} />
                <Kpi label="Unrealized profit" value={egp(gain)} toneOf={gain} delta={gainPct}
                  hint={s.realized == null ? "before selling fees" : `Realized, per the broker: ${egp(s.realized)}`} />
              </div>

              <RealOrders key={start?.symbol ?? "orders"} holdings={data.holdings} start={start} onChanged={refresh} />

              <div className="card flush section">
                <div className="card-head"><h2>Holdings<span className="count">{data.holdings.length} position{data.holdings.length === 1 ? "" : "s"}</span></h2></div>
                {data.holdings.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Stock</th><th className="l col-wide">Sector</th><th>Qty</th><th>Free to sell</th><th>Avg cost</th><th>Broker price</th>
                          <th>App price</th><th>Value</th><th>Weight</th><th>Unrealized P/L</th></tr>
                      </thead>
                      <tbody>
                        {data.holdings.map((h: any, i: number) => <HoldingRow key={h.symbol ?? `${h.name}-${i}`} h={h} />)}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty icon={Briefcase} title="No holdings">The account holds no shares right now: it is all cash.</Empty>
                )}
                <p className="foot-note">
                  Amounts in {data.currency}. Cost, price, value and profit are the broker&apos;s figures, before selling fees. “App price” is
                  the latest price in the app&apos;s own market data for the same stock.
                </p>
              </div>

              <div className="card section">
                <div className="card-head">
                  <h2>Checks on this reading</h2>
                  <span className={`badge ${failed ? "warn" : "ok"}`}>{failed ? `${failed} to look at` : "all passed"}</span>
                </div>
                <ul className="checks">
                  {data.checks.map((c: any) => (
                    <li key={c.label} className={c.ok ? "ok" : "warn"}>
                      {c.ok ? <CircleCheck size={16} aria-label="Passed" /> : <TriangleAlert size={16} aria-label="Look at this" />}
                      <div><strong>{c.label}</strong><span>{c.detail}</span></div>
                    </li>
                  ))}
                </ul>
                {data.notes.length > 0 && <div className="note info" style={{ margin: "14px 0 0" }}><ul>{data.notes.map((n: string) => <li key={n} dir="auto">{n}</li>)}</ul></div>}
                <p className="foot-note">
                  These are the checks the app can make by itself. Compare the totals above with the EFG Hermes ONE app once: if they match,
                  this reading is the same account, seen the same way.
                </p>
              </div>

              <p className="foot-note" style={{ maxWidth: "110ch" }}>
                The account&apos;s figures are read from the broker when the page opens and when you refresh; they are not stored. Real orders,
                and what became of them, are kept in your own data and in the activity log. The paper portfolio is separate: no paper trade,
                stop-loss or automatic run changes this account, and nothing here enters the <Link href="/portfolio">paper portfolio</Link>.
              </p>
            </>
          )}
        </State>
      )}
    </>
  );
}
