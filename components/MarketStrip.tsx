"use client";
import { egp, pct, tone } from "@/lib/format";
import { useIndexTick } from "@/lib/live";
import { useApi } from "@/lib/useApi";

function IndexItem({ i }: { i: any }) {
  const tick = useIndexTick(i.symbol);
  const value = tick?.[0] ?? i.last;
  const change = tick?.[1] ?? i.change_pct;
  return (
    <span className="it">
      <b>{i.symbol}</b>
      <span className="v">{value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
      <span className={tone(change)}>{pct(change)}</span>
    </span>
  );
}

/** The figures a trader wants in the corner of every screen: the indices, breadth and the portfolio. */
export default function MarketStrip() {
  const ov = useApi("/api/v1/market/overview");
  const pf = useApi("/api/v1/portfolio");
  const b = ov.data?.breadth;
  const s = pf.data?.summary;
  if (!ov.data && !pf.data) return null;
  return (
    <div className="strip" role="region" aria-label="Market summary" tabIndex={0}>
      {ov.data?.indices?.map((i: any) => <IndexItem key={i.symbol} i={i} />)}
      {ov.data?.indices?.length > 0 && <span className="sep" aria-hidden="true" />}
      {b && (
        <span className="it"><b>Breadth</b>
          <span className="up">{b.advancers} up</span><span className="down">{b.decliners} down</span><span className="muted">{b.unchanged} flat</span>
        </span>
      )}
      {s && (
        <>
          <span className="sep hide-sm" aria-hidden="true" />
          <span className="it hide-sm"><b>Paper portfolio</b><span className="v">{egp(s.total_value)}</span>
            <span className={tone(s.total_net)}>{pct(s.return_net_pct)} net</span></span>
          <span className="it hide-sm"><b>Cash</b><span className="v">{egp(s.cash)}</span></span>
        </>
      )}
    </div>
  );
}
