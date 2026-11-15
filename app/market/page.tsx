"use client";
import { useMemo, useState } from "react";
import { api } from "@/lib/api";
import { big, pct } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import StockTable from "@/components/StockTable";
import Treemap, { HeatScale } from "@/components/Treemap";
import { CardHead, Chg, Kpi, State } from "@/components/ui";

export default function Market() {
  const [sector, setSector] = useState("");
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const sectors = useApi("/api/v1/market/sectors");
  const cats = useApi("/api/v1/categories");
  const ov = useApi("/api/v1/market/overview");
  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (sector) p.set("sector", sector);
    if (category) p.set("category", category);
    if (q.trim()) p.set("q", q.trim());
    return p.toString();
  }, [sector, category, q]);
  const stocks = useApi(`/api/v1/stocks${params ? `?${params}` : ""}`);
  const all = useApi("/api/v1/stocks"); // the map always shows the whole market
  const [view, setView] = useState<"map" | "sectors">("map");
  const [newCat, setNewCat] = useState({ name: "", symbols: "" });
  const [catError, setCatError] = useState<string | null>(null);
  const b = ov.data?.breadth;
  const selected = sectors.data?.find((s: any) => s.sector === sector);

  const addCategory = async () => {
    setCatError(null);
    try {
      await api("/api/v1/categories", { method: "POST", json: { name: newCat.name, symbols: newCat.symbols.split(/[\s,]+/).filter(Boolean) } });
      setNewCat({ name: "", symbols: "" });
      cats.reload();
    } catch (e: any) {
      setCatError(e.message);
    }
  };
  const removeCategory = async (id: string) => {
    await api(`/api/v1/categories/${id}`, { method: "DELETE" });
    if (category === id) setCategory("");
    cats.reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Market</h1>
          <p className="sub">Every EGX stock by sector, with your own custom groups.</p>
        </div>
        <div className="seg" role="group" aria-label="View">
          <button className={view === "map" ? "on" : ""} aria-pressed={view === "map"} onClick={() => setView("map")}>Market map</button>
          <button className={view === "sectors" ? "on" : ""} aria-pressed={view === "sectors"} onClick={() => setView("sectors")}>Sectors</button>
        </div>
      </div>

      {b && (
        <div className="statband">
          <Kpi label="Stocks covered" value={String(b.covered)} hint={`${all.data?.filter((r: any) => r.volume > 0).length ?? "—"} traded today`} />
          <Kpi label="Rising / falling" value={<><span className="up">{b.advancers}</span> <span className="muted">/</span> <span className="down">{b.decliners}</span></>} hint={`${b.unchanged} unchanged`} />
          <Kpi label="Average move today" value={pct(b.avg_change_pct)} toneOf={b.avg_change_pct} />
          <Kpi label="Value traded" value={`EGP ${big(b.turnover_approx)}`} hint={`${big(b.volume)} shares · approximate`} />
        </div>
      )}

      {view === "map" ? (
        <div className="card section">
          <CardHead title="Market map"><HeatScale /></CardHead>
          <State loading={all.loading} error={all.error} skeleton={<span className="skel" style={{ height: 460 }} />}>
            {all.data && <Treemap rows={all.data} />}
          </State>
          <p className="foot-note">
            Each tile is a stock, grouped by sector. A larger tile traded more value today (on a compressed scale, so small stocks stay visible);
            colour shows the day&apos;s change. Select a tile to open the stock.
          </p>
        </div>
      ) : (
        <div className="card flush section">
          <div className="card-head"><h2>Sector performance</h2></div>
          <State loading={sectors.loading} error={sectors.error}>
            {sectors.data && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Sector</th><th>Stocks</th><th>Day</th><th>Week</th><th>Month</th><th title="Average daily volume over 20 sessions">Avg vol. 20d</th><th>Best today</th><th>Worst today</th>
                      <th title="Sector return over one month minus the market's">Vs market 1m</th></tr>
                  </thead>
                  <tbody>
                    {sectors.data.map((s: any) => (
                      <tr key={s.sector} className="clickable" onClick={() => (setSector(s.sector), setCategory(""))} aria-selected={sector === s.sector}>
                        <td><strong className="trunc" style={{ maxWidth: 230 }} title={s.sector}>{s.sector}</strong></td><td>{s.stocks}</td><td><Chg v={s.day_pct} /></td><td><Chg v={s.week_pct} /></td><td><Chg v={s.month_pct} /></td>
                        <td>{big(s.avg_volume)}</td>
                        <td>{s.best ? <><span className="muted">{s.best.symbol}</span> <Chg v={s.best.change_pct} /></> : "—"}</td>
                        <td>{s.worst ? <><span className="muted">{s.worst.symbol}</span> <Chg v={s.worst.change_pct} /></> : "—"}</td>
                        <td><Chg v={s.relative_strength} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </State>
          <p className="foot-note">Sector figures are equal-weight averages of the covered stocks, not official sector indices. Select a row to filter the list below.</p>
        </div>
      )}

      <div className="card flush section">
        <div className="card-head">
          <h2>{selected ? selected.sector : category ? (cats.data?.find((c: any) => c.id === category)?.name ?? "Custom category") : "All stocks"}{stocks.data ? <span className="count">{stocks.data.length} shown</span> : null}</h2>
        </div>
        <div className="toolbar">
          <input aria-label="Search by symbol or company" placeholder="Filter by ticker or company" value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Sector" value={sector} onChange={(e) => (setSector(e.target.value), setCategory(""))}>
            <option value="">All sectors</option>
            {sectors.data?.map((s: any) => <option key={s.sector}>{s.sector}</option>)}
          </select>
          <select aria-label="Custom category" value={category} onChange={(e) => (setCategory(e.target.value), setSector(""))}>
            <option value="">No custom category</option>
            {cats.data?.map((c: any) => <option key={c.id} value={c.id}>{c.name} ({c.symbols.length})</option>)}
          </select>
          {(sector || category || q) && <button className="ghost" onClick={() => (setSector(""), setCategory(""), setQ(""))}>Clear filters</button>}
        </div>
        <State loading={stocks.loading} error={stocks.error}>
          {stocks.data && <StockTable rows={stocks.data} onChange={stocks.reload} empty="No stocks match these filters." />}
        </State>
      </div>

      <div className="card section">
        <CardHead title="Custom categories"><span className="muted" style={{ fontSize: 12.5 }}>Your own groups of stocks, usable as a filter above</span></CardHead>
        <div className="row">
          <div><label htmlFor="cat-name">Name</label><input id="cat-name" value={newCat.name} maxLength={60} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} placeholder="e.g. Dividend payers" /></div>
          <div style={{ flex: "3 1 260px" }}><label htmlFor="cat-sym">Symbols (comma or space separated)</label><input id="cat-sym" value={newCat.symbols} onChange={(e) => setNewCat({ ...newCat, symbols: e.target.value })} placeholder="COMI, TMGH, SWDY" /></div>
          <button className="primary fit" disabled={!newCat.name.trim()} onClick={addCategory}>Add category</button>
        </div>
        {catError && <div className="note danger" role="alert" style={{ marginTop: 10 }}>{catError}</div>}
        {cats.data?.length ? (
          <div className="table-wrap" style={{ marginTop: 6 }}>
            <table>
              <thead><tr><th>Category</th><th className="l">Stocks</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {cats.data.map((c: any) => (
                  <tr key={c.id}>
                    <td><strong>{c.name}</strong></td>
                    <td className="l wrap muted">{c.symbols.join(", ") || "—"}</td>
                    <td className="actions"><button className="small" onClick={() => (setCategory(c.id), setSector(""))}>View</button>
                      <button className="small danger" onClick={() => removeCategory(c.id)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </>
  );
}
