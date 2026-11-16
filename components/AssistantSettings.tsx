"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { useStatus } from "@/components/Shell";
import { State } from "@/components/ui";

/** Fired on `window` when the assistant's settings were saved, so the background job re-reads them. */
export const ASSISTANT_SETTINGS = "egx:assistant-settings";

const ACCESS: Record<string, [string, string]> = {
  full: ["Full access", "Carries out what you ask straight away, trades and deletions included."],
  confirm: ["Ask me first", "Shows each trade, run change, deletion or settings change and waits for your approval."],
  read: ["Look only", "Answers and reads your data, but changes nothing."],
};
const EFFORT: Record<string, string> = {
  low: "Low: quickest and cheapest", medium: "Medium: balanced (recommended)", high: "High: thinks longer",
  xhigh: "Extra high: for hard analysis", max: "Maximum: slowest, most expensive",
};
const AUTOPILOT: Record<string, [string, string]> = {
  off: ["Off", "The assistant only acts when you ask."],
  after_close: ["After each close", "One review of the portfolio and the market after every completed session."],
  intraday: ["During the session too", "The review after each close, plus a check every so many minutes while the market is open."],
};
const LANGUAGE: Record<string, [string, string]> = {
  auto: ["The language I write in", "Arabic when you write Arabic, English when you write English."],
  ar: ["Always Arabic (Egyptian)", "Answers in Egyptian Arabic whatever language you write in. Symbols and screen names stay as they are."],
  en: ["Always English", "Answers in English whatever language you write in."],
};
const usd = (v: unknown) => `$${Number(v ?? 0).toFixed(2)}`;

/** How much of a ceiling is used. Without a ceiling there is nothing to fill. */
function Used({ label, spent, limit }: { label: string; spent: number; limit: number }) {
  const part = limit > 0 ? Math.min(spent / limit, 1) : 0;
  return (
    <div className="used">
      <div className="used-line"><span>{label}</span><strong className="num">{usd(spent)}{limit > 0 ? <span className="muted"> of {usd(limit)}</span> : <span className="muted"> · no ceiling</span>}</strong></div>
      <div className={`meter ${part >= 1 ? "full" : part >= 0.8 ? "near" : ""}`} role="img" aria-label={limit > 0 ? `${Math.round(part * 100)}% of the ceiling used` : "no ceiling set"}><span style={{ width: `${part * 100}%` }} /></div>
    </div>
  );
}

const LIMITS: [string, string, string, number, number][] = [
  ["max_trade_pct", "Largest single trade", "% of the portfolio", 1, 100],
  ["max_position_pct", "Largest holding in one stock", "% of the portfolio", 1, 100],
  ["min_cash_pct", "Cash always kept", "% of the portfolio", 0, 90],
  ["max_trades_per_day", "Trades per day", "trades", 0, 200],
];

export default function AssistantSettings() {
  const { data, loading, error, reload } = useApi("/api/v1/assistant");
  const [draft, setDraft] = useState<any>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const live = useStatus()?.real_orders;   // whether this sign-in is the brokerage account's owner, and what is switched on
  useEffect(() => {
    const s = data?.settings;
    if (s) setDraft({ model: s.model, effort: s.effort, access: s.access, daily_usd: s.daily_usd, monthly_usd: s.monthly_usd,
                      language: s.language, instructions: s.instructions, real_proposals_per_day: s.real_proposals_per_day, ...s.limits,
                      autopilot_mode: s.autopilot.mode, autopilot_every_minutes: s.autopilot.every_minutes, autopilot_mandate: s.autopilot.mandate,
                      autopilot_max_per_day: s.autopilot.max_per_day, autopilot_notify: s.autopilot.notify });
  }, [data]);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = { ...draft };
      for (const k of ["daily_usd", "monthly_usd", "max_trade_pct", "max_position_pct", "min_cash_pct", "max_trades_per_day", "autopilot_every_minutes",
                       "real_proposals_per_day", "autopilot_max_per_day"]) body[k] = Number(body[k]);
      await api("/api/v1/assistant/settings", { method: "PUT", json: body });
      setMsg({ ok: true, text: "Saved. The new settings apply from the assistant's next reply." });
      window.dispatchEvent(new Event(ASSISTANT_SETTINGS));
      reload();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: any) => setDraft((d: any) => ({ ...d, ...patch }));
  const model = data?.models?.find((m: any) => m.id === draft?.model);
  const spend = data?.spending;

  return (
    <State loading={loading} error={error}>
      {data && !data.configured && (
        <div className="card">
          <h2>Assistant</h2>
          <p>The assistant is not connected. It runs on Claude through an API key saved on the server as <code>ANTHROPIC_API_KEY</code>; without one it stays off and nothing is charged.</p>
        </div>
      )}
      {data?.configured && !data.allowed && (
        <div className="card"><h2>Assistant</h2><p>The assistant is switched on for administrators only.</p></div>
      )}
      {data?.configured && data.allowed && draft && (
        <>
          {data.problem && <div className="note danger" role="alert"><strong>Claude is not answering.</strong> {data.problem}</div>}
          <div className="card">
            <h2>Model and access</h2>
            <div className="grid cols-2">
              <div className="field">
                <label htmlFor="as-model">Model</label>
                <select id="as-model" value={draft.model} onChange={(e) => set({ model: e.target.value })}>
                  {data.models.map((m: any) => <option key={m.id} value={m.id}>{m.name} · ${m.input_usd_per_mtok} in / ${m.output_usd_per_mtok} out per million tokens</option>)}
                </select>
                <p className="foot-note" style={{ marginTop: 6 }}>{model?.about} Model id: <code>{draft.model}</code></p>
              </div>
              <div className="field">
                <label htmlFor="as-effort">How much it thinks</label>
                <select id="as-effort" value={draft.effort} onChange={(e) => set({ effort: e.target.value })}>
                  {data.efforts.map((e: string) => <option key={e} value={e}>{EFFORT[e] ?? e}</option>)}
                </select>
                <p className="foot-note" style={{ marginTop: 6 }}>More thinking costs more and takes longer. Medium suits most questions.</p>
              </div>
              <div className="field">
                <label htmlFor="as-acc">What it may do</label>
                <select id="as-acc" value={draft.access} onChange={(e) => set({ access: e.target.value })}>
                  {data.access_levels.map((a: string) => <option key={a} value={a}>{ACCESS[a]?.[0] ?? a}</option>)}
                </select>
                <p className="foot-note" style={{ marginTop: 6 }}>{ACCESS[draft.access]?.[1]} This is about the paper portfolio and your notes. It never manages sign-in accounts, and it cannot approve or cancel a real order.</p>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>What it costs</h2>
            <p className="muted" style={{ marginTop: 0, maxWidth: "110ch" }}>
              The assistant runs on Claude and is billed per use. When a ceiling is reached it stops answering and reviewing until the day or the month turns, or you raise it here.
              The figures are an estimate from the tokens used; the bill itself comes from Anthropic.
            </p>
            {spend && (
              <div className="grid cols-2" style={{ marginBottom: 12 }}>
                <div>
                  <Used label="Today" spent={spend.today_usd} limit={Number(draft.daily_usd) || 0} />
                  <p className="foot-note" style={{ marginTop: 6 }}>Conversations {usd(spend.today_by.chat)} · reviews by itself {usd(spend.today_by.autopilot)}</p>
                </div>
                <div>
                  <Used label="This month" spent={spend.month_usd} limit={Number(draft.monthly_usd) || 0} />
                  <p className="foot-note num" style={{ marginTop: 6 }}>Last 7 days: {spend.days.slice().reverse().map((d: any) => `${String(d.date).slice(8)}: ${usd(d.usd)}`).join(" · ")}</p>
                </div>
              </div>
            )}
            <div className="grid cols-2">
              <div className="field">
                <label htmlFor="as-daily">Most in one day (USD, 0 for no ceiling)</label>
                <input id="as-daily" type="number" min={0} max={200} step={0.5} value={draft.daily_usd} onChange={(e) => set({ daily_usd: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="as-monthly">Most in one month (USD, 0 for no ceiling)</label>
                <input id="as-monthly" type="number" min={0} max={3000} step={1} value={draft.monthly_usd} onChange={(e) => set({ monthly_usd: e.target.value })} />
              </div>
            </div>
          </div>

          <div className="card">
            <h2>How it answers</h2>
            <div className="grid cols-2">
              <div className="field">
                <label htmlFor="as-lang">Language</label>
                <select id="as-lang" value={draft.language} onChange={(e) => set({ language: e.target.value })}>
                  {(data.languages ?? ["auto", "ar", "en"]).map((l: string) => <option key={l} value={l}>{LANGUAGE[l]?.[0] ?? l}</option>)}
                </select>
                <p className="foot-note" style={{ marginTop: 6 }}>{LANGUAGE[draft.language]?.[1]}</p>
              </div>
            </div>
            <div className="field">
              <label htmlFor="as-inst">Your standing instructions, for every conversation. Arabic or English.</label>
              <textarea id="as-inst" dir="auto" rows={4} maxLength={2000} value={draft.instructions} onChange={(e) => set({ instructions: e.target.value })}
                placeholder="e.g. Keep answers short. Always give the stop-loss with any idea. I only trade banks and real estate." />
              <p className="foot-note" style={{ marginTop: 6 }}>It follows these in conversations and in its own reviews. They change how it works and answers, not what the app lets it do: the limits below still hold.</p>
            </div>
          </div>

          <div className="card">
            <h2>Limits on the assistant&apos;s own trades</h2>
            <p className="muted" style={{ marginTop: 0, maxWidth: "110ch" }}>Checked by the app on every trade the assistant places, whatever it was asked. A trade outside them is refused and it is told why. Trades you place yourself are not affected.</p>
            <div className="grid cols-4">
              {LIMITS.map(([key, label, unit, min, max]) => (
                <div className="field" key={key}>
                  <label htmlFor={`as-${key}`}>{label}</label>
                  <input id={`as-${key}`} type="number" min={min} max={max} value={draft[key]} aria-describedby={`as-${key}-unit`} onChange={(e) => set({ [key]: e.target.value })} />
                  <p className="foot-note" id={`as-${key}-unit`} style={{ marginTop: 6 }}>{unit}</p>
                </div>
              ))}
            </div>
          </div>

          {live?.allowed && (
            <div className="card">
              <div className="card-head"><h2>Real money</h2>
                <span className={`badge ${live.auto ? "bad" : live.ready ? "warn" : ""}`}>{live.auto ? "automatic orders on" : live.ready ? "proposals only" : "real orders off"}</span></div>
              <p className="muted" style={{ marginTop: 0, maxWidth: "110ch" }}>
                For the brokerage account&apos;s owner. The assistant can only <em>propose</em> a real order. A proposal goes to the broker when you approve it or,
                with automatic orders on, by itself when it fits the box you set: the stocks, the most per order, the most in one day, the budget.
                Those money limits live in <Link href="/settings?tab=real">Real trading</Link>.
              </p>
              <div className="grid cols-2">
                <div className="field">
                  <label htmlFor="as-props">Real-order proposals it may write in one day (0 for none)</label>
                  <input id="as-props" type="number" min={0} max={50} value={draft.real_proposals_per_day} onChange={(e) => set({ real_proposals_per_day: e.target.value })} />
                  <p className="foot-note" style={{ marginTop: 6 }}>With 0 it reads the real account but writes no proposal at all.</p>
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head"><h2>Autopilot</h2>
              <span className={`badge ${draft.autopilot_mode === "off" ? "" : "ok"}`}>{draft.autopilot_mode !== "off" && <span className="dot" />}{AUTOPILOT[draft.autopilot_mode]?.[0] ?? draft.autopilot_mode}</span></div>
            <p className="muted" style={{ marginTop: 0, maxWidth: "110ch" }}>
              Lets the assistant review the portfolio and trade by itself, inside the limits above. Each review is a new conversation you can read afterwards,
              and each one uses the API (typically a few cents to a few tens of cents, depending on the model). It runs while the app is open
              {live?.background ? ", and on the server with the app closed, because you switched on running without the app open." : "; to keep it going with the app closed, see Real trading → Running without the app open."}
            </p>
            {spend?.autopilot?.reviews_a_day > 0 && (
              <div className="note info" style={{ marginBottom: 14 }}>
                <strong>What a day can cost.</strong> The schedule saved now asks for at most {spend.autopilot.reviews_a_day} review{spend.autopilot.reviews_a_day === 1 ? "" : "s"} a day.{" "}
                {spend.autopilot.review_usd != null
                  ? <>{spend.autopilot.reviews_counted === 1 ? "Your one review this week cost" : `Your ${spend.autopilot.reviews_counted} reviews this week cost on average`} about {usd(spend.autopilot.review_usd)}, so about <strong>{usd(spend.autopilot.day_usd)} a day</strong>.</>
                  : <>No review has run in the last week, so there is no figure of your own yet.</>}{" "}
                {Number(spend.daily_limit_usd) > 0
                  ? <>It can never pass your daily ceiling of {usd(spend.daily_limit_usd)}, conversations included: at the ceiling it stops reviewing and proposing until the next day.</>
                  : <>There is no daily ceiling: set one above to bound it.</>}{" "}
                Watching stop-losses and sending what was already decided is the app&apos;s own work and costs nothing here.
              </div>
            )}
            <div className="grid cols-2">
              <div className="field">
                <label htmlFor="as-auto">When it reviews</label>
                <select id="as-auto" value={draft.autopilot_mode} onChange={(e) => set({ autopilot_mode: e.target.value })}>
                  {data.autopilot_modes.map((m: string) => <option key={m} value={m}>{AUTOPILOT[m]?.[0] ?? m}</option>)}
                </select>
                <p className="foot-note" style={{ marginTop: 6 }}>{AUTOPILOT[draft.autopilot_mode]?.[1]}</p>
              </div>
              <div className="field">
                <label htmlFor="as-every">Minutes between checks during the session</label>
                <input id="as-every" type="number" min={15} max={240} step={5} value={draft.autopilot_every_minutes}
                  disabled={draft.autopilot_mode !== "intraday"} onChange={(e) => set({ autopilot_every_minutes: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="as-reviews">Most reviews in one day</label>
                <input id="as-reviews" type="number" min={1} max={48} value={draft.autopilot_max_per_day}
                  disabled={draft.autopilot_mode === "off"} onChange={(e) => set({ autopilot_max_per_day: e.target.value })} />
                <p className="foot-note" style={{ marginTop: 6 }}>Each review costs money: this bounds a day whatever the schedule.</p>
              </div>
              <div className="field">
                <span className="label-like">After a review</span>
                <label className="check" style={{ marginTop: 6 }}>
                  <input type="checkbox" checked={!!draft.autopilot_notify} onChange={(e) => set({ autopilot_notify: e.target.checked })} />
                  <span>Tell my devices when a review changed something</span>
                </label>
                <p className="foot-note" style={{ marginTop: 6 }}>Needs notifications switched on for the device (Real trading → Running without the app open). A review that stops with an error is always told.</p>
              </div>
            </div>
            <div className="field">
              <label htmlFor="as-mandate">Your instructions to it (goals, style, what to avoid). Arabic or English.</label>
              <textarea id="as-mandate" dir="auto" rows={5} maxLength={4000} value={draft.autopilot_mandate} onChange={(e) => set({ autopilot_mandate: e.target.value })}
                placeholder="e.g. Trade only liquid stocks in an uptrend. Risk at most 1% of the portfolio per trade. Hold no more than five positions." />
            </div>
            {draft.autopilot_mode !== "off" && draft.access !== "full" && (
              <div className="note">With “{ACCESS[draft.access]?.[0]}” the autopilot only looks and reports. It trades by itself only with Full access.</div>
            )}
            {data.autopilot?.last_run && <p className="foot-note">Last review: {String(data.autopilot.last_run).slice(0, 16).replace("T", " ")} UTC.</p>}
          </div>

          {msg && <div className={`note ${msg.ok ? "info" : "danger"}`} role={msg.ok ? "status" : "alert"}>{msg.text}</div>}
          <div className="form-actions"><button className="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save assistant settings"}</button></div>
        </>
      )}
    </State>
  );
}
