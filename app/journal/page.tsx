"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { State } from "@/components/ui";

const QUESTIONS: [string, string, boolean][] = [
  ["thesis", "Why was this stock selected?", true],
  ["expected", "What price movement did you expect?", false],
  ["evidence", "What evidence supported the decision?", false],
  ["exit_condition", "What was the exit condition?", false],
  ["outcome", "What actually happened?", false],
  ["lesson", "What did you learn?", false],
];

function Journal() {
  const params = useSearchParams();
  const [status, setStatus] = useState("");
  const list = useApi(`/api/v1/journal${status ? `?status=${status}` : ""}`);
  const blank = () => ({ symbol: params.get("symbol") || "", trade_seq: params.get("trade") ? Number(params.get("trade")) : null,
    entry_date: params.get("date") || "", thesis: "", expected: "", evidence: "", exit_condition: "", outcome: "", lesson: "", status: "open" });
  const [draft, setDraft] = useState<any>(params.get("symbol") ? blank() : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    const { id, created_at, updated_at, ...rest } = draft;
    try {
      await api(id ? `/api/v1/journal/${id}` : "/api/v1/journal", { method: id ? "PUT" : "POST",
        json: { ...rest, symbol: rest.symbol || null, entry_date: rest.entry_date || null } });
      setDraft(null);
      list.reload();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const remove = async (e: any) => {
    if (!confirm("Delete this journal entry?")) return;
    await api(`/api/v1/journal/${e.id}`, { method: "DELETE" });
    list.reload();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Investment Journal</h1>
          <p className="sub">Write down why you made each decision, then come back and record what happened. It shows whether a strategy works or the market was simply kind.</p>
        </div>
        {!draft && <button className="primary" onClick={() => (setDraft(blank()), setError(null))}>New entry</button>}
      </div>

      {draft && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h2>{draft.id ? "Edit entry" : "New entry"}{draft.trade_seq ? ` · ledger #${draft.trade_seq}` : ""}</h2>
          <div className="row">
            <div className="field"><label htmlFor="j-sym">Stock</label><input id="j-sym" maxLength={12} value={draft.symbol ?? ""} onChange={(e) => setDraft({ ...draft, symbol: e.target.value.toUpperCase() })} placeholder="COMI" /></div>
            <div className="field"><label htmlFor="j-date">Decision date</label><input id="j-date" type="date" value={draft.entry_date ?? ""} onChange={(e) => setDraft({ ...draft, entry_date: e.target.value })} /></div>
            <div className="field"><label htmlFor="j-status">Status</label><select id="j-status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}><option value="open">Open — still running</option><option value="closed">Closed — reviewed</option></select></div>
          </div>
          {QUESTIONS.map(([key, label, required]) => (
            <div className="field" key={key}><label htmlFor={`j-${key}`}>{label}{required ? " (required)" : ""}</label>
              <textarea id={`j-${key}`} rows={2} maxLength={4000} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} /></div>
          ))}
          {error && <div className="note danger" role="alert">{error}</div>}
          <div className="row">
            <button className="primary fit" disabled={busy || !draft.thesis.trim()} onClick={save}>{busy ? "Saving…" : "Save entry"}</button>
            <button className="fit" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="toolbar">
          <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All entries</option><option value="open">Open</option><option value="closed">Closed</option></select>
        </div>
        <State loading={list.loading} error={list.error}>
          {list.data && (list.data.length ? list.data.map((e: any) => (
            <div key={e.id} style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "space-between" }}>
                <strong>{e.symbol ? <Link href={`/stock?symbol=${e.symbol}`}>{e.symbol}</Link> : "General"} · {e.entry_date ?? e.created_at.slice(0, 10)}</strong>
                <span className={`badge ${e.status === "open" ? "warn" : "ok"}`}>{e.status === "open" ? "open" : "closed, reviewed"}</span>
              </div>
              <dl className="kv" style={{ gridTemplateColumns: "minmax(140px, 220px) 1fr", marginTop: 8 }}>
                {QUESTIONS.filter(([k]) => e[k]).map(([k, label]) => (
                  <div key={k} style={{ display: "contents" }}><dt>{label}</dt><dd style={{ textAlign: "left", whiteSpace: "pre-wrap" }}>{e[k]}</dd></div>
                ))}
              </dl>
              {e.status === "open" && !e.outcome && <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Outcome not recorded yet.</p>}
              <div style={{ marginTop: 6 }}>
                <button className="small" onClick={() => (setDraft({ ...e }), setError(null), window.scrollTo({ top: 0 }))}>{e.status === "open" ? "Record outcome / edit" : "Edit"}</button>{" "}
                <button className="small danger" onClick={() => remove(e)}>Delete</button>
              </div>
            </div>
          )) : <div className="empty">No entries yet. Start one when you place a trade, from the ledger or here.</div>)}
        </State>
      </div>
    </>
  );
}

export default function JournalPage() {
  return <Suspense fallback={<div className="empty">Loading…</div>}><Journal /></Suspense>;
}
