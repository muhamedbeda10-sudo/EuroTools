"use client";
import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { pct, price, tone } from "@/lib/format";

/** Jump to any stock from anywhere: type a ticker or a company name. "/" focuses the box. */
export default function SymbolSearch() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [stocks, setStocks] = useState<any[] | null>(null);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const load = () => {
    if (stocks === null) api("/api/v1/stocks").then(setStocks).catch(() => setStocks([]));
  };
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || !stocks) return [];
    const starts = stocks.filter((r) => r.symbol.toLowerCase().startsWith(s));
    const rest = stocks.filter((r) => !r.symbol.toLowerCase().startsWith(s) && (r.symbol.toLowerCase().includes(s) || r.name.toLowerCase().includes(s)));
    return [...starts, ...rest].slice(0, 8);
  }, [q, stocks]);
  useEffect(() => setCursor(0), [q]);

  const go = (symbol: string) => {
    setOpen(false);
    setQ("");
    input.current?.blur();
    router.push(`/stock?symbol=${symbol}`);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Enter" && hits[cursor]) { e.preventDefault(); go(hits[cursor].symbol); }
    else if (e.key === "Escape") { setOpen(false); input.current?.blur(); }
  };
  const showing = open && q.trim().length > 0;

  return (
    <div className="search">
      <Search className="lead" size={15} aria-hidden="true" />
      <input ref={input} role="combobox" aria-expanded={showing} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={showing && hits[cursor] ? `${listId}-${cursor}` : undefined}
        aria-label="Search stocks by ticker or company name" placeholder="Search stocks…" value={q} autoComplete="off" spellCheck={false}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => { load(); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 120)} onKeyDown={onKeyDown} />
      {!q && <kbd aria-hidden="true">/</kbd>}
      {showing && (
        <div className="search-pop" role="listbox" id={listId}>
          {stocks === null ? <div className="none">Loading stocks…</div>
            : hits.length === 0 ? <div className="none">No stock matches “{q.trim()}”.</div>
            : hits.map((r, i) => (
              <div key={r.symbol} id={`${listId}-${i}`} role="option" aria-selected={i === cursor}
                onMouseEnter={() => setCursor(i)} onMouseDown={(e) => { e.preventDefault(); go(r.symbol); }}>
                <strong>{r.symbol}</strong><span className="nm">{r.name}</span>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{price(r.last)}</span>
                <span className={tone(r.change_pct)} style={{ fontVariantNumeric: "tabular-nums", minWidth: 58, textAlign: "right" }}>{pct(r.change_pct)}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
