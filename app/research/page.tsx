"use client";
import { Newspaper, Plus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { CATEGORIES, ResearchItem } from "@/components/ResearchItem";
import { Empty, State } from "@/components/ui";

const blank = () => ({ title: "", url: "", source: "", published: "", symbols: "", sectors: [] as string[], strategy_ids: [] as string[],
  category: "news", summary: "", notes: "", sentiment: "neutral", importance: 2, reliability: "unverified", verified: false });

function Research() {
  const preset = useSearchParams().get("symbol") || "";
  const [filter, setFilter] = useState({ symbol: preset, sector: "", category: "", q: "" });
  const query = useMemo(() => {
    const p = new URLSearchParams();
    Object.entries(filter).forEach(([k, v]) => v.trim() && p.set(k, v.trim()));
    return p.toString();
  }, [filter]);
  const list = useApi(`/api/v1/research${query ? `?${query}` : ""}`);
  const sectors = useApi("/api/v1/market/sectors");
  const strategies = useApi("/api/v1/strategies");
  const [draft, setDraft] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: any) => setDraft({ ...draft, ...patch });

  const save = async () => {
    setBusy(true);
    setError(null);
    const { id, created_at, updated_at, ...rest } = draft;
    const body = { ...rest, url: rest.url || null, published: rest.published || null,
      symbols: typeof rest.symbols === "string" ? rest.symbols.split(/[\s,]+/).filter(Boolean) : rest.symbols };
    try {
      await api(id ? `/api/v1/research/${id}` : "/api/v1/research", { method: id ? "PUT" : "POST", json: body });
      setDraft(null);
      list.reload();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const remove = async (item: any) => {
    if (!confirm(`Delete "${item.title}"?`)) return;
    await api(`/api/v1/research/${item.id}`, { method: "DELETE" });
    list.reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Research &amp; News</h1>
          <p className="sub">Collect links and notes, and tie each one to the stocks, sectors and strategies it concerns.</p>
        </div>
        {!draft && <button className="primary" onClick={() => (setDraft({ ...blank(), symbols: preset }), setError(null))}><Plus size={15} aria-hidden="true" />Add item</button>}
      </div>
      <div className="note info"><strong>A headline is not a verified fact.</strong> Mark an item verified only after checking it against the company&apos;s own disclosure or financial statements.</div>

      {draft && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h2>{draft.id ? "Edit item" : "New item"}</h2>
          <div className="row">
            <div className="field" style={{ flex: "3 1 280px" }}><label htmlFor="r-title">Title</label><input id="r-title" maxLength={200} value={draft.title} onChange={(e) => set({ title: e.target.value })} /></div>
            <div className="field" style={{ flex: "3 1 280px" }}><label htmlFor="r-url">Link (https://…)</label><input id="r-url" type="url" value={draft.url ?? ""} onChange={(e) => set({ url: e.target.value })} /></div>
          </div>
          <div className="row">
            <div className="field"><label htmlFor="r-cat">Category</label><select id="r-cat" value={draft.category} onChange={(e) => set({ category: e.target.value })}>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="field"><label htmlFor="r-src">Source</label><input id="r-src" maxLength={120} value={draft.source} onChange={(e) => set({ source: e.target.value })} placeholder="EGX, Reuters, company IR…" /></div>
            <div className="field"><label htmlFor="r-date">Publication date</label><input id="r-date" type="date" value={draft.published ?? ""} onChange={(e) => set({ published: e.target.value })} /></div>
            <div className="field"><label htmlFor="r-sym">Stocks (comma separated)</label><input id="r-sym" value={Array.isArray(draft.symbols) ? draft.symbols.join(", ") : draft.symbols} onChange={(e) => set({ symbols: e.target.value.toUpperCase() })} placeholder="COMI, TMGH" /></div>
          </div>
          <div className="row top">
            <div className="field"><label htmlFor="r-sec">Sectors (Ctrl / Cmd for several)</label><select id="r-sec" multiple size={3} value={draft.sectors} onChange={(e) => set({ sectors: Array.from(e.target.selectedOptions, (o) => o.value) })}>{(sectors.data ?? []).map((s: any) => <option key={s.sector}>{s.sector}</option>)}</select></div>
            <div className="field"><label htmlFor="r-str">Strategies</label><select id="r-str" multiple size={3} value={draft.strategy_ids} onChange={(e) => set({ strategy_ids: Array.from(e.target.selectedOptions, (o) => o.value) })}>{(strategies.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
            <div className="field"><label htmlFor="r-sent">Likely impact</label><select id="r-sent" value={draft.sentiment} onChange={(e) => set({ sentiment: e.target.value })}><option value="positive">Positive</option><option value="neutral">Neutral</option><option value="negative">Negative</option></select></div>
            <div className="field"><label htmlFor="r-imp">Importance</label><select id="r-imp" value={draft.importance} onChange={(e) => set({ importance: Number(e.target.value) })}><option value={1}>Low</option><option value={2}>Medium</option><option value={3}>High</option></select></div>
            <div className="field"><label htmlFor="r-rel">Source reliability</label><select id="r-rel" value={draft.reliability} onChange={(e) => set({ reliability: e.target.value })}><option value="official">Official (exchange, company, regulator)</option><option value="reputable">Reputable publication</option><option value="unverified">Unverified</option></select></div>
          </div>
          <div className="field"><label htmlFor="r-sum">Short summary</label><textarea id="r-sum" rows={2} maxLength={2000} value={draft.summary} onChange={(e) => set({ summary: e.target.value })} /></div>
          <div className="field"><label htmlFor="r-notes">Your notes</label><textarea id="r-notes" rows={3} maxLength={4000} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></div>
          <label className="check" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={draft.verified} onChange={(e) => set({ verified: e.target.checked })} /> I checked this against an official source
          </label>
          {error && <div className="note danger" role="alert">{error}</div>}
          <div className="form-actions">
            <button className="primary" disabled={busy || !draft.title.trim()} onClick={save}>{busy ? "Saving…" : "Save item"}</button>
            <button onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="toolbar">
          <input aria-label="Search research" placeholder="Search title, summary, notes" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
          <input aria-label="Filter by stock" placeholder="Stock, e.g. COMI" value={filter.symbol} onChange={(e) => setFilter({ ...filter, symbol: e.target.value.toUpperCase() })} style={{ minWidth: 120 }} />
          <select aria-label="Filter by sector" value={filter.sector} onChange={(e) => setFilter({ ...filter, sector: e.target.value })}><option value="">All sectors</option>{(sectors.data ?? []).map((s: any) => <option key={s.sector}>{s.sector}</option>)}</select>
          <select aria-label="Filter by category" value={filter.category} onChange={(e) => setFilter({ ...filter, category: e.target.value })}><option value="">All categories</option>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </div>
        <State loading={list.loading} error={list.error}>
          {list.data && (list.data.length
            ? <div className="list">{list.data.map((item: any) => <ResearchItem key={item.id} item={item} onEdit={() => (setDraft({ ...item }), setError(null), window.scrollTo({ top: 0 }))} onDelete={() => remove(item)} />)}</div>
            : query ? <Empty icon={Newspaper} title="Nothing matches these filters" action={<button onClick={() => setFilter({ symbol: "", sector: "", category: "", q: "" })}>Clear filters</button>} />
            : <Empty icon={Newspaper} title="Your library is empty">Add a news link, a disclosure or a report, and tie it to the stocks it concerns.</Empty>)}
        </State>
      </div>
    </>
  );
}

export default function ResearchPage() {
  return <Suspense fallback={<div className="empty">Loading…</div>}><Research /></Suspense>;
}
