"use client";
import { useEffect, useRef, useState } from "react";
import { api, request } from "@/lib/api";
import { egp } from "@/lib/format";
import { DATA_UPDATED, useApi } from "@/lib/useApi";
import { useFeedUpdate } from "@/components/Shell";
import { CardHead, Empty, State } from "@/components/ui";

function Fees() {
  const { data, loading, error, reload } = useApi("/api/v1/settings/fees");
  const [draft, setDraft] = useState<any>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (data) setDraft(structuredClone(data)); }, [data]);
  const setItem = (i: number, patch: any) => setDraft({ ...draft, items: draft.items.map((it: any, j: number) => (j === i ? { ...it, ...patch } : it)) });
  const save = async () => {
    setMsg(null);
    try {
      const body = { ...draft, items: draft.items.map((it: any) => ({ ...it, maximum: it.maximum === "" || it.maximum == null ? null : it.maximum })) };
      await api("/api/v1/settings/fees", { method: "PUT", json: body });
      setMsg({ ok: true, text: "Fee schedule saved. It applies to new trades and backtests; recorded trades keep the fees they were charged." });
      reload();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    }
  };
  return (
    <div className="card">
      <CardHead title="Brokerage and market fee schedule">
        {draft && <span className={`badge ${draft.verified ? "ok" : "warn"}`}>{draft.verified ? "Verified against the tariff" : "Placeholder rates"}</span>}
      </CardHead>
      <State loading={loading} error={error}>
        {draft && (
          <>
            {!draft.verified && <div className="note"><strong>These rates are placeholders, not your broker&apos;s tariff.</strong> Check each line against the current tariff, then tick “verified”.</div>}
            <div className="table-wrap">
              <table className="form-table">
                <thead><tr><th>Charge</th><th>Rate (% of value)</th><th>Fixed (EGP)</th><th>Minimum (EGP)</th><th>Maximum (EGP)</th><th className="l">Applies to</th><th>Enabled</th></tr></thead>
                <tbody>
                  {draft.items.map((it: any, i: number) => (
                    <tr key={it.code}>
                      <td><input aria-label="Charge name" value={it.name} maxLength={80} onChange={(e) => setItem(i, { name: e.target.value })} style={{ minWidth: 190 }} /></td>
                      {(["rate_pct", "fixed", "minimum", "maximum"] as const).map((k) => (
                        <td key={k}><input aria-label={`${it.name} ${k}`} type="number" min="0" step="any" value={it[k] ?? ""} placeholder={k === "maximum" ? "none" : "0"}
                          onChange={(e) => setItem(i, { [k]: e.target.value === "" ? (k === "maximum" ? null : "0") : e.target.value })} style={{ width: 96 }} /></td>
                      ))}
                      <td className="l"><select aria-label={`${it.name} applies to`} value={it.applies_to} onChange={(e) => setItem(i, { applies_to: e.target.value })} style={{ minWidth: 130 }}>
                        <option value="both">Buy and sell</option><option value="buy">Buy only</option><option value="sell">Sell only</option></select></td>
                      <td><input aria-label={`${it.name} enabled`} type="checkbox" checked={it.enabled} onChange={(e) => setItem(i, { enabled: e.target.checked })} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="field" style={{ marginTop: 4 }}><label htmlFor="fee-note">Note (source and date of the tariff)</label>
              <input id="fee-note" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></div>
            <div className="form-actions" style={{ justifyContent: "space-between" }}>
              <label className="check">
                <input type="checkbox" checked={draft.verified} onChange={(e) => setDraft({ ...draft, verified: e.target.checked })} />
                I verified this against my broker&apos;s tariff
              </label>
              <button className="primary" onClick={save}>Save fee schedule</button>
            </div>
            {msg && <div className={`note ${msg.ok ? "info" : "danger"}`} role={msg.ok ? "status" : "alert"} style={{ marginTop: 12 }}>{msg.text}</div>}
          </>
        )}
      </State>
    </div>
  );
}

function Capital() {
  const { data, reload } = useApi("/api/v1/settings");
  const [capital, setCapital] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (data) setCapital(String(Number(data.starting_capital))); }, [data]);
  const save = async () => {
    setMsg(null);
    try {
      await api("/api/v1/settings", { method: "PUT", json: { starting_capital: Number(capital) } });
      setMsg({ ok: true, text: "Saved. The new amount is used the next time the paper portfolio is reset." });
      reload();
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };
  const reset = async () => {
    if (!confirm(`Start a new paper portfolio with ${egp(Number(data.starting_capital))}? The current ledger is archived, not deleted.`)) return;
    setMsg(null);
    try {
      await api("/api/v1/portfolio/reset", { method: "POST" });
      setMsg({ ok: true, text: "New paper portfolio started. The previous ledger is kept in the database." });
    } catch (e: any) { setMsg({ ok: false, text: e.message }); }
  };
  return (
    <div className="card">
      <h2>Paper portfolio</h2>
      <div className="row" style={{ maxWidth: 520 }}>
        <div className="field"><label htmlFor="cap">Starting capital (EGP)</label><input id="cap" type="number" min="1" value={capital} onChange={(e) => setCapital(e.target.value)} /></div>
        <button className="primary fit" onClick={save} disabled={!capital}>Save</button>
      </div>
      {data && (
        <dl className="kv ruled" style={{ maxWidth: 520, marginBottom: 14 }}>
          <dt>Currency</dt><dd>{data.currency}</dd>
          <dt>Benchmark</dt><dd>{data.benchmark}</dd>
          <dt>Trading calendar</dt><dd>Sunday–Thursday, public holidays not modelled yet</dd>
        </dl>
      )}
      {msg && <div className={`note ${msg.ok ? "info" : "danger"}`} role={msg.ok ? "status" : "alert"}>{msg.text}</div>}
      <h3 style={{ marginTop: 20 }}>Start over</h3>
      <p className="muted" style={{ maxWidth: "70ch" }}>A reset starts a new paper portfolio with the starting capital above. The current ledger is archived, not deleted.</p>
      <button className="danger" onClick={reset} disabled={!data}>Reset paper portfolio</button>
    </div>
  );
}

function DataImport() {
  const status = useApi("/api/v1/status");
  const file = useRef<HTMLInputElement>(null);
  const [f, setF] = useState({ symbol: "", name: "", sector: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const d = status.data?.data;
  const upload = async () => {
    const chosen = file.current?.files?.[0];
    if (!chosen) return setMsg({ ok: false, text: "Choose a CSV file first." });
    setBusy(true);
    setMsg(null);
    const body = new FormData();
    body.set("symbol", f.symbol.trim());
    body.set("file", chosen);
    if (f.name.trim()) body.set("name", f.name.trim());
    if (f.sector.trim()) body.set("sector", f.sector.trim());
    try {
      const json = await (await request("/api/v1/data/bars/import", { method: "POST", body })).json();
      setMsg({ ok: true, text: `${json.symbol}: imported ${json.rows} bars (${json.first_date} → ${json.last_date}). Any sample data for this stock was replaced.` });
      status.reload();
    } catch (e: any) { setMsg({ ok: false, text: e.message }); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <h2>Historical data</h2>
      {d && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Stocks</th><th>Bars</th><th>From</th><th>To</th></tr></thead>
            <tbody>
              {d.sources.map((s: any) => <tr key={s.source}><td><strong>{s.source === "sample" ? "Sample (synthetic)" : s.source === "younit" ? "Younit (daily)" : "Imported CSV"}</strong></td><td>{s.symbols}</td><td>{Number(s.bars).toLocaleString("en-US")}</td><td>{s.first_date}</td><td>{s.last_date}</td></tr>)}
            </tbody>
          </table>
        </div>
      )}
      <h3 style={{ marginTop: 18 }}>Import a CSV</h3>
      <p className="muted" style={{ maxWidth: "90ch" }}>Import daily history for one stock. Columns: <code>date, open, high, low, close, volume</code>. The import replaces that stock&apos;s whole history. Prices are used as given, so adjust for splits and bonus shares before importing.</p>
      <div className="row">
        <div><label htmlFor="im-sym">Symbol</label><input id="im-sym" value={f.symbol} maxLength={12} onChange={(e) => setF({ ...f, symbol: e.target.value.toUpperCase() })} placeholder="COMI" /></div>
        <div><label htmlFor="im-file">CSV file (max 5 MB)</label><input id="im-file" ref={file} type="file" accept=".csv,text/csv" /></div>
        <div><label htmlFor="im-name">Company name (new symbols only)</label><input id="im-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label htmlFor="im-sec">Sector (new symbols only)</label><input id="im-sec" value={f.sector} onChange={(e) => setF({ ...f, sector: e.target.value })} /></div>
        <button className="primary fit" disabled={busy || !f.symbol.trim()} onClick={upload}>{busy ? "Importing…" : "Import"}</button>
      </div>
      {msg && <div className={`note ${msg.ok ? "info" : "danger"}`} role={msg.ok ? "status" : "alert"} style={{ marginTop: 12 }}>{msg.text}</div>}
    </div>
  );
}

function AccountsCard() {
  const { data, error, reload } = useApi("/api/v1/accounts");
  const [f, setF] = useState({ name: "", email: "", password: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (error) return <div className="card"><h2>Accounts</h2><div className="note danger" role="alert">{error}</div></div>;
  if (!data?.can_manage) return null; // only administrators see this card
  const ready = f.name.trim() && f.email.trim() && f.password.length >= 8;
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const a = await api("/api/v1/accounts", { method: "POST", json: f });
      setMsg({ ok: true, text: `Account created for ${a.email}. Give them the email and password; they sign in at this same address.` });
      setF({ name: "", email: "", password: "" });
      reload();
    } catch (err: any) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (a: any) => {
    if (a.active && !confirm(`Deactivate ${a.email}? They will be locked out immediately. Their data is kept.`)) return;
    setMsg(null);
    try {
      await api(`/api/v1/accounts/${a.uid}`, { method: "PUT", json: { active: !a.active } });
      reload();
    } catch (err: any) {
      setMsg({ ok: false, text: err.message });
    }
  };
  return (
    <div className="card">
      <h2>Accounts</h2>
      <p className="muted">
        Create a sign-in for another person. Each account gets its own separate paper portfolio and settings, and cannot see anyone
        else&apos;s. Accounts created here can use EGX Intelligence only.
      </p>
      <form className="row" onSubmit={create}>
        <div><label htmlFor="ac-name">Name</label><input id="ac-name" maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label htmlFor="ac-email">Email</label><input id="ac-email" type="email" autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
        <div><label htmlFor="ac-pass">Password (8 characters or more)</label>
          <input id="ac-pass" type="text" autoComplete="off" minLength={8} maxLength={128} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
        <button className="primary fit" type="submit" disabled={busy || !ready}>{busy ? "Creating…" : "Create account"}</button>
      </form>
      {msg && <div className={`note ${msg.ok ? "info" : "danger"}`} role={msg.ok ? "status" : "alert"} style={{ marginTop: 12 }}>{msg.text}</div>}
      {data.accounts.length ? (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th>Name</th><th className="l">Email</th><th>Created</th><th>Status</th><th>&nbsp;</th></tr></thead>
            <tbody>
              {data.accounts.map((a: any) => (
                <tr key={a.uid}>
                  <td>{a.name}</td><td className="l">{a.email}</td><td>{String(a.createdAt ?? "").slice(0, 10)}</td>
                  <td>{a.active ? <span className="badge ok">Active</span> : <span className="badge bad">Deactivated</span>}</td>
                  <td><button className={`small ${a.active ? "danger" : ""}`} onClick={() => toggle(a)}>{a.active ? "Deactivate" : "Reactivate"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No accounts created here yet" />
      )}
    </div>
  );
}

function Audit() {
  const { data, loading, error } = useApi("/api/v1/audit?limit=50");
  return (
    <div className="card">
      <h2>Audit trail<span className="count"> latest 50</span></h2>
      <State loading={loading} error={error}>
        {data && (
          <div className="table-wrap" style={{ maxHeight: 520, overflowY: "auto" }}>
            <table>
              <thead><tr><th>#</th><th>When (UTC)</th><th className="l">Action</th><th className="l">What</th><th className="l">Detail</th></tr></thead>
              <tbody>
                {data.map((a: any) => {
                  const dt = a.detail || {};
                  const text = dt.email ?? dt.after?.name ?? dt.name ?? dt.strategy ?? (dt.symbol ? `${dt.side ?? ""} ${dt.qty ?? ""} ${dt.symbol}`.trim() : dt.id ?? dt.reason ?? "");
                  return <tr key={a.seq}><td className="muted">{a.seq}</td><td>{a.ts.slice(0, 19).replace("T", " ")}</td><td className="l"><span className="badge">{a.action}</span></td><td className="l">{a.entity.replace(/_/g, " ")}</td><td className="l wrap muted">{String(text)}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
      </State>
    </div>
  );
}

const TABS = [["fees", "Fees"], ["portfolio", "Paper portfolio"], ["data", "Market data"], ["accounts", "Accounts"], ["audit", "Audit trail"]] as const;

export default function Settings() {
  const status = useApi("/api/v1/status");
  const feed = useFeedUpdate();
  const pv = status.data?.provider;
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("fees");
  useEffect(() => { if (feed.state.done) window.dispatchEvent(new Event(DATA_UPDATED)); }, [feed.state.done, feed.state.changed]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">The assumptions behind every number in the app.</p>
        </div>
      </div>
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      <div className="grid" role="tabpanel" aria-label={TABS.find(([k]) => k === tab)?.[1]}>
        {tab === "fees" && <Fees />}
        {tab === "portfolio" && <Capital />}
        {tab === "data" && <DataImport />}
        {tab === "accounts" && <AccountsCard />}
        {tab === "accounts" && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Only an administrator sees the account list. If nothing is shown above, this account cannot manage others.</p>}
        {(tab === "data") && <div className="card">
          <h2>Connections</h2>
          <dl className="kv ruled" style={{ maxWidth: 720 }}>
            <dt>Trading mode</dt><dd>Paper only</dd>
            <dt>Younit market data</dt><dd>{pv?.configured ? "Connected, read-only" : "Not connected"}</dd>
            {pv?.configured && (
              <>
                <dt>Stocks in the feed</dt><dd>{pv.symbols} ({pv.with_history} with price history)</dd>
                <dt>Latest daily bar</dt><dd>{pv.latest_bar_date ?? "—"}</dd>
                <dt>Last updated</dt><dd>{pv.updated_at ? `${pv.updated_at.slice(0, 16).replace("T", " ")} UTC` : "never"}</dd>
              </>
            )}
            {pv?.configured && (
              <>
                <dt>Live prices</dt>
                <dd>
                  {pv.live?.stocks
                    ? `${pv.live.stocks} stocks trading, as of ${String(pv.live.as_of).slice(0, 16).replace("T", " ")} Cairo`
                    : pv.live ? `No trades reported yet (${pv.live.answered ?? 0} of ${pv.live.asked ?? 0} stocks answered)` : "No live snapshot yet"}
                  {pv.market_open ? " · market open" : " · market closed"}
                </dd>
              </>
            )}
            {pv?.live && (
              <>
                <dt>Sectors / indices from the feed</dt><dd>{pv.live.sectors} stocks classified · {pv.live.indices} indices</dd>
              </>
            )}
            <dt>Live order execution</dt><dd>Disabled — not part of this release</dd>
            <dt>Fundamental data</dt><dd>Not connected</dd>
          </dl>
          {status.data && <p className="foot-note" style={{ marginTop: 14 }}>{status.data.broker_note}</p>}
          {pv?.live?.errors?.length > 0 && <div className="note" style={{ marginTop: 8 }}>Live feed notes: {pv.live.errors.join("; ")}</div>}
          {pv?.fields?.length > 0 && (
            <details style={{ margin: "8px 0 12px" }}>
              <summary className="muted">Fields the feed sends for each stock (for troubleshooting)</summary>
              <p className="muted" style={{ fontSize: 12, wordBreak: "break-word", marginTop: 6 }}>{pv.fields.join(", ")}</p>
            </details>
          )}
          {pv?.configured && (
            <>
              <button onClick={feed.run} disabled={feed.state.running}>
                {feed.state.running
                  ? `Updating… ${feed.state.total ? `${feed.state.total - (feed.state.left ?? feed.state.total)} of ${feed.state.total}` : ""}`
                  : "Update market data now"}
              </button>
              {feed.state.done && <div className="note info" role="status" style={{ marginTop: 10 }}>Market data is up to date. Prices are re-checked at most every 15 minutes.</div>}
              {feed.state.error && <div className="note danger" role="alert" style={{ marginTop: 10 }}>{feed.state.error}</div>}
              {pv.errors?.length > 0 && !feed.state.error && (
                <div className="note" style={{ marginTop: 10 }}>Some stocks failed on the last update: {pv.errors.join("; ")}</div>
              )}
            </>
          )}
        </div>}
        {tab === "audit" && <Audit />}
      </div>
    </>
  );
}
