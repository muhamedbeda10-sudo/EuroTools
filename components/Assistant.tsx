"use client";
import { Check, CircleAlert, History, Loader, Plus, SendHorizontal, Sparkles, Square, Trash2, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api, request } from "@/lib/api";
import { DATA_UPDATED } from "@/lib/useApi";
import Markdown from "./Markdown";

type ToolChip = { id: string; label: string; state: "running" | "ok" | "failed" | "declined" | "waiting" };
type Item = { role: "user" | "assistant" | "note"; text: string; tools?: ToolChip[] };
type Pending = { id: string; label: string };
type Status = {
  configured: boolean; allowed: boolean; access: "full" | "confirm" | "read" | null; problem?: string | null;
  /** The model that answers in a conversation, and the one the reviews it makes by itself run on. */
  model: string | null; trading_model: string | null; models: { id: string; name: string; about: string }[];
  spent_today_usd: number; daily_limit_usd: number; chats: { id: string; title: string; updated_at: string; kind?: string }[];
};

const ACCESS: [NonNullable<Status["access"]>, string, string][] = [
  ["full", "Full access", "Carries out what you ask straight away: trades, runs, changes and deletions included."],
  ["confirm", "Ask me first", "Shows you each trade, run change, deletion or settings change and waits for your approval."],
  ["read", "Look only", "Answers questions and reads your data, but changes nothing."],
];
const IDEAS = ["How is the market doing today?", "Review my portfolio and its risks", "Which bank stocks moved most this week?",
               "Build and test a moving-average strategy"];
const STORE_KEY = "egx-assistant-chat";

const usd = (v?: number | null) => (v == null ? "—" : v < 0.01 ? "< $0.01" : `$${v.toFixed(2)}`);

function fromServer(view: any): Item[] {
  return (view.items as any[]).map((i) => ({
    role: i.role, text: i.text,
    tools: (i.tools ?? []).map((t: any) => ({
      id: t.id, label: t.label, state: t.declined ? "declined" : t.ok == null ? "waiting" : t.ok ? "ok" : "failed",
    })),
  }));
}

function Chip({ tool }: { tool: ToolChip }) {
  const icon = tool.state === "running" ? <Loader size={13} className="spin" aria-hidden="true" />
    : tool.state === "ok" ? <Check size={13} aria-hidden="true" />
    : tool.state === "waiting" ? <CircleAlert size={13} aria-hidden="true" /> : <X size={13} aria-hidden="true" />;
  const word = { running: "working", ok: "done", failed: "not done", declined: "declined", waiting: "waiting for you" }[tool.state];
  return <li className={`as-tool ${tool.state}`}>{icon}<span dir="auto">{tool.label}</span><span className="sr-only"> ({word})</span></li>;
}

function Panel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const path = usePathname();
  const query = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [chat, setChat] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await api<Status>("/api/v1/assistant");
      setStatus(s);
      return s;
    } catch (e: any) {
      setFailed(e.message);
      return null;
    }
  }, []);

  const open = useCallback(async (id: string) => {
    try {
      const view = await api(`/api/v1/assistant/chats/${id}`);
      setChat(id);
      setItems(fromServer(view));
      setPending(view.pending ?? []);
      setCost(view.usage?.cost_usd ?? null);
      setError(view.full ? "This conversation has grown very long. Start a new one to carry on." : null);
      try { localStorage.setItem(STORE_KEY, id); } catch {}
    } catch {
      setChat(null);
      setItems([]);
      try { localStorage.removeItem(STORE_KEY); } catch {}
    }
  }, []);

  useEffect(() => {
    (async () => {
      const s = await loadStatus();
      if (!s?.configured || !s.allowed) return;
      let saved: string | null = null;
      try { saved = localStorage.getItem(STORE_KEY); } catch {}
      if (saved && s.chats.some((c) => c.id === saved)) await open(saved);
    })();
    return () => abort.current?.abort();
  }, [loadStatus, open]);

  // Escape closes the panel when the keyboard is in it (or nowhere), not while typing in a page field.
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as Node | null;
      if (e.key === "Escape" && (target === document.body || (target && panel.current?.contains(target)))) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [items, progress, pending, busy, error]);

  const fresh = () => {
    abort.current?.abort();
    setChat(null); setItems([]); setPending([]); setError(null); setCost(null); setShowHistory(false);
    try { localStorage.removeItem(STORE_KEY); } catch {}
    input.current?.focus();
  };

  /** Read the reply as it is produced and fold each step into what is on screen. */
  const stream = async (url: string, body: unknown) => {
    setBusy(true); setError(null); setProgress("");
    let changed = false;
    const controller = new AbortController();
    abort.current = controller;
    const patch = (fn: (list: Item[]) => Item[]) => setItems((list) => fn(list.map((i) => ({ ...i, tools: i.tools?.map((t) => ({ ...t })) }))));
    const current = (list: Item[], needText: boolean) => {
      const last = list[list.length - 1];
      // text that follows finished tool calls belongs to the next step, shown as its own block
      if (last?.role === "assistant" && !(needText && last.tools?.length)) return last;
      const next: Item = { role: "assistant", text: "", tools: [] };
      list.push(next);
      return next;
    };
    const handle = (e: any) => {
      if (e.type === "text") { setProgress(""); patch((l) => { current(l, true).text += e.text; return l; }); }
      else if (e.type === "reset") patch((l) => { const c = l[l.length - 1]; if (c?.role === "assistant") c.text = ""; return l; });
      else if (e.type === "progress") setProgress(e.text);
      else if (e.type === "tool") { setProgress(""); patch((l) => {
        const c = current(l, false);
        c.tools = [...(c.tools ?? []).filter((t) => t.id !== e.id), { id: e.id, label: e.label, state: "running" }];
        return l;
      }); }
      else if (e.type === "tool_done") {
        if (e.changed) changed = true;
        patch((l) => { for (const i of l) for (const t of i.tools ?? []) if (t.id === e.id) t.state = e.declined ? "declined" : e.ok ? "ok" : "failed"; return l; });
        if (e.navigate) router.push(e.navigate);
      }
      else if (e.type === "confirm") {
        setPending(e.actions);
        patch((l) => { const c = current(l, false); c.tools = [...(c.tools ?? []), ...e.actions.map((a: Pending) => ({ ...a, state: "waiting" as const }))]; return l; });
      }
      else if (e.type === "notice") patch((l) => [...l, { role: "note", text: e.text }]);
      else if (e.type === "error") setError(e.detail);
      else if (e.type === "done") setCost(e.usage?.cost_usd ?? null);
    };
    try {
      const res = await request(url, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, signal: controller.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of block.split("\n")) if (line.startsWith("data:")) handle(JSON.parse(line.slice(5)));
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") setError(e.message ?? "The assistant could not be reached.");
    } finally {
      setBusy(false); setProgress("");
      abort.current = null;
      if (changed) window.dispatchEvent(new Event(DATA_UPDATED)); // every screen re-reads what the assistant changed
      loadStatus();
    }
  };

  const send = async (message: string) => {
    const words = message.trim();
    if (!words || busy) return;
    setText("");
    let id = chat;
    try {
      if (!id) {
        id = (await api("/api/v1/assistant/chats", { method: "POST" })).id as string;
        setChat(id);
        try { localStorage.setItem(STORE_KEY, id); } catch {}
      }
    } catch (e: any) {
      setError(e.message);
      return;
    }
    setPending([]);
    setItems((l) => [...l.map((i) => ({ ...i, tools: i.tools?.map((t) => (t.state === "waiting" ? { ...t, state: "declined" as const } : t)) })),
                     { role: "user", text: words }]);
    const page = `${path}${query.toString() ? `?${query}` : ""}`;
    await stream(`/api/v1/assistant/chats/${id}/messages`, { text: words, page });
  };

  const decide = async (decisions: Record<string, "approve" | "decline">) => {
    if (!chat || busy) return;
    setPending([]);
    await stream(`/api/v1/assistant/chats/${chat}/resolve`, { decisions });
  };

  const setAccess = async (access: string) => {
    try {
      await api("/api/v1/assistant/settings", { method: "PUT", json: { access } });
      loadStatus();
    } catch (e: any) { setError(e.message); }
  };

  /** The model that answers in conversations: saved for the account, and used from the next message on. */
  const setModel = async (model: string) => {
    try {
      await api("/api/v1/assistant/settings", { method: "PUT", json: { model } });
      loadStatus();
    } catch (e: any) { setError(e.message); }
  };

  const remove = async (id: string) => {
    try { await api(`/api/v1/assistant/chats/${id}`, { method: "DELETE" }); } catch {}
    if (id === chat) fresh();
    loadStatus();
  };

  const ready = status?.configured && status.allowed;
  const level = ACCESS.find(([k]) => k === status?.access);
  // A review the assistant made by itself runs on the model chosen for trading, your replies in it included.
  const review = status?.chats.find((c) => c.id === chat)?.kind === "autopilot";
  const running = review ? status?.trading_model : status?.model;
  const modelName = (id?: string | null) => status?.models?.find((m) => m.id === id)?.name ?? id ?? "";
  // the message box takes the keyboard as soon as it exists, and again after leaving the history list
  useEffect(() => { if (ready && !showHistory) input.current?.focus(); }, [ready, showHistory, chat]);

  return (
    <aside className="assistant" role="complementary" aria-label="Assistant" ref={panel}>
      <header className="as-head">
        <Sparkles size={17} aria-hidden="true" />
        <div className="as-title"><strong>Assistant</strong>
          {running && <span title={review ? "This is a review it made by itself: it runs on the model chosen for trading by itself (Settings → Assistant)."
                                           : "The model that answers here. Change it in the list at the bottom of this panel."}>
            {modelName(running)}{review ? " · its own review" : ""}</span>}</div>
        {ready && (
          <>
            <button className="icon-btn ghost" onClick={() => setShowHistory((v) => !v)} aria-pressed={showHistory} aria-label="Earlier conversations" title="Earlier conversations"><History size={16} /></button>
            <button className="icon-btn ghost" onClick={fresh} aria-label="New conversation" title="New conversation"><Plus size={17} /></button>
          </>
        )}
        <button className="icon-btn ghost" onClick={onClose} aria-label="Close the assistant" title="Close"><X size={17} /></button>
      </header>

      {failed ? <div className="as-body"><div className="note danger" role="alert">{failed}</div></div>
        : !status ? <div className="as-body"><div className="empty center">Loading…</div></div>
        : !status.configured ? (
          <div className="as-body">
            <h3>The assistant is not connected yet</h3>
            <p>It runs on Claude, through an API key that belongs to you. Until a key is added nothing is charged and this panel stays off.</p>
            <ol>
              <li>Create an API key in the Anthropic Console and add credit to the account.</li>
              <li>Save it on the server as <code>ANTHROPIC_API_KEY</code> (marked sensitive), then redeploy.</li>
            </ol>
            <p className="muted">The key stays on the server. It is never sent to this page.</p>
          </div>
        ) : !status.allowed ? (
          <div className="as-body"><p>The assistant is switched on for administrators only. Ask the administrator if you need it.</p></div>
        ) : showHistory ? (
          <div className="as-body">
            <h3>Earlier conversations</h3>
            {status.chats.length === 0 ? <div className="empty">None yet.</div> : (
              <ul className="as-history">
                {status.chats.map((c) => (
                  <li key={c.id}>
                    <button className="ghost" onClick={() => { setShowHistory(false); open(c.id); }} aria-current={c.id === chat ? "true" : undefined}>
                      <span dir="auto">{c.title}</span><small>{c.updated_at.slice(0, 16).replace("T", " ")}</small>
                    </button>
                    <button className="icon-btn ghost" onClick={() => remove(c.id)} aria-label={`Delete the conversation ${c.title}`} title="Delete"><Trash2 size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <>
            <div className="as-body" ref={log} role="log" aria-live="polite" aria-label="Conversation">
              {items.length === 0 && (
                <div className="as-empty">
                  <p>Ask about the market, a stock or your portfolio, or tell it what to do: place a paper trade, build and test a strategy, set an alert. Arabic or English.</p>
                  <div className="as-ideas">{IDEAS.map((q) => <button key={q} onClick={() => send(q)}>{q}</button>)}</div>
                </div>
              )}
              {items.map((item, n) => item.role === "user" ? <div key={n} className="as-user" dir="auto">{item.text}</div>
                : item.role === "note" ? <div key={n} className="note info" role="status">{item.text}</div>
                : (
                  <div key={n} className="as-reply">
                    {item.text && <Markdown text={item.text} />}
                    {!!item.tools?.length && <ul className="as-tools">{item.tools.map((t) => <Chip key={t.id} tool={t} />)}</ul>}
                  </div>
                ))}
              {pending.length > 0 && !busy && (
                <div className="as-confirm" role="group" aria-label="Actions waiting for your approval">
                  <strong>Waiting for your approval</strong>
                  <ul>{pending.map((p) => (
                    <li key={p.id}>
                      <span dir="auto">{p.label}</span>
                      <span className="as-yesno">
                        <button className="small primary" onClick={() => decide(Object.fromEntries(pending.map((x) => [x.id, x.id === p.id ? "approve" : "decline"])))}>
                          {pending.length > 1 ? "Only this" : "Approve"}
                        </button>
                      </span>
                    </li>
                  ))}</ul>
                  <div className="as-yesno">
                    {pending.length > 1 && <button className="small primary" onClick={() => decide(Object.fromEntries(pending.map((x) => [x.id, "approve"])))}>Approve all</button>}
                    <button className="small" onClick={() => decide(Object.fromEntries(pending.map((x) => [x.id, "decline"])))}>Decline</button>
                  </div>
                </div>
              )}
              {status.problem && !busy && <div className="note danger" role="alert"><strong>Claude is not answering yet.</strong> {status.problem}</div>}
              {busy && <div className="as-working" role="status"><Loader size={14} className="spin" aria-hidden="true" /><span dir="auto">{progress || "Working…"}</span></div>}
              {error && <div className="note danger" role="alert">{error}</div>}
            </div>

            <form className="as-compose" onSubmit={(e) => { e.preventDefault(); send(text); }}>
              <label htmlFor="as-input" className="sr-only">Message to the assistant</label>
              <textarea id="as-input" ref={input} dir="auto" rows={2} value={text} maxLength={8000} placeholder="Ask, or say what to do…"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); } }} />
              {busy
                ? <button type="button" className="icon-btn" onClick={() => abort.current?.abort()} aria-label="Stop" title="Stop"><Square size={15} /></button>
                : <button type="submit" className="icon-btn primary" disabled={!text.trim()} aria-label="Send" title="Send"><SendHorizontal size={16} /></button>}
            </form>
            <div className="as-foot">
              <label htmlFor="as-chat-model" className="sr-only">The model that answers</label>
              {review
                ? <select id="as-chat-model" value={running ?? ""} disabled title="A review it made by itself stays on the model chosen for trading by itself. Change that one in Settings → Assistant.">
                    <option value={running ?? ""}>{modelName(running)}</option>
                  </select>
                : <select id="as-chat-model" value={status.model ?? ""} onChange={(e) => setModel(e.target.value)} disabled={busy}
                    title={`${status.models.find((m) => m.id === status.model)?.about ?? ""} Used from your next message on; the model that trades by itself is chosen in Settings → Assistant.`}>
                    {status.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>}
              <label htmlFor="as-access" className="sr-only">What the assistant may do</label>
              <select id="as-access" value={status.access ?? "full"} onChange={(e) => setAccess(e.target.value)} disabled={busy} title={level?.[2]}>
                {ACCESS.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
              </select>
              <span className="as-break" aria-hidden="true" />
              <span className="muted" title={`About ${usd(status.spent_today_usd)} used today${status.daily_limit_usd ? ` of a ${usd(status.daily_limit_usd)} daily ceiling` : ""}. An estimate from the tokens used.`}>
                {cost != null ? `This chat ≈ ${usd(cost)} · ` : ""}today ≈ {usd(status.spent_today_usd)}
              </span>
              <Link className="muted" href="/settings?tab=assistant" title="The model that trades by itself, limits and autopilot">Settings</Link>
            </div>
          </>
        )}
    </aside>
  );
}

/** The assistant's panel, docked at the right edge of every screen. */
export default function Assistant({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <Suspense fallback={null}><Panel onClose={onClose} /></Suspense>;
}
