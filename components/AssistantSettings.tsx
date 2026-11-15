"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";
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
  useEffect(() => {
    const s = data?.settings;
    if (s) setDraft({ model: s.model, effort: s.effort, access: s.access, daily_usd: s.daily_usd, ...s.limits,
                      autopilot_mode: s.autopilot.mode, autopilot_every_minutes: s.autopilot.every_minutes, autopilot_mandate: s.autopilot.mandate });
  }, [data]);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const body = { ...draft };
      for (const k of ["daily_usd", "max_trade_pct", "max_position_pct", "min_cash_pct", "max_trades_per_day", "autopilot_every_minutes"]) body[k] = Number(body[k]);
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
            <h2>Model and cost</h2>
            <div className="grid cols-2">
              <div className="field">
                <label htmlFor="as-model">Model</label>
                <select id="as-model" value={draft.model} onChange={(e) => set({ model: e.target.value })}>
                  {data.models.map((m: any) => <option key={m.id} value={m.id}>{m.name} · ${m.input_usd_per_mtok} in / ${m.output_usd_per_mtok} out per million tokens</option>)}
                </select>
                <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>{model?.about} Model id: <code>{draft.model}</code></p>
              </div>
              <div className="field">
                <label htmlFor="as-effort">How much it thinks</label>
                <select id="as-effort" value={draft.effort} onChange={(e) => set({ effort: e.target.value })}>
                  {data.efforts.map((e: string) => <option key={e} value={e}>{EFFORT[e] ?? e}</option>)}
                </select>
                <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>More thinking costs more and takes longer. Medium suits most questions.</p>
              </div>
              <div className="field">
                <label htmlFor="as-daily">Daily spending ceiling (USD, 0 for none)</label>
                <input id="as-daily" type="number" min={0} max={200} step={0.5} value={draft.daily_usd} onChange={(e) => set({ daily_usd: e.target.value })} />
                <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>
                  About ${Number(data.spent_today_usd).toFixed(2)} used today. An estimate from the tokens used; the bill itself comes from Anthropic.
                </p>
              </div>
              <div className="field">
                <label htmlFor="as-acc">What it may do</label>
                <select id="as-acc" value={draft.access} onChange={(e) => set({ access: e.target.value })}>
                  {data.access_levels.map((a: string) => <option key={a} value={a}>{ACCESS[a]?.[0] ?? a}</option>)}
                </select>
                <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>{ACCESS[draft.access]?.[1]} It can never place a real order or manage sign-in accounts.</p>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Limits on the assistant&apos;s own trades</h2>
            <p className="muted" style={{ marginTop: 0 }}>Checked by the app on every trade the assistant places, whatever it was asked. A trade outside them is refused and it is told why. Trades you place yourself are not affected.</p>
            <div className="grid cols-4" style={{ alignItems: "end" }}>
              {LIMITS.map(([key, label, unit, min, max]) => (
                <div className="field" key={key}>
                  <label htmlFor={`as-${key}`}>{label} ({unit})</label>
                  <input id={`as-${key}`} type="number" min={min} max={max} value={draft[key]} onChange={(e) => set({ [key]: e.target.value })} />
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h2>Autopilot</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Lets the assistant review the portfolio and trade by itself, inside the limits above. Each review is a new conversation you can read afterwards,
              and each one uses the API (typically a few cents to a few tens of cents, depending on the model). It runs while the app is open in a browser tab.
            </p>
            <div className="grid cols-2">
              <div className="field">
                <label htmlFor="as-auto">When it reviews</label>
                <select id="as-auto" value={draft.autopilot_mode} onChange={(e) => set({ autopilot_mode: e.target.value })}>
                  {data.autopilot_modes.map((m: string) => <option key={m} value={m}>{AUTOPILOT[m]?.[0] ?? m}</option>)}
                </select>
                <p className="muted" style={{ fontSize: 12.5, margin: "6px 0 0" }}>{AUTOPILOT[draft.autopilot_mode]?.[1]}</p>
              </div>
              <div className="field">
                <label htmlFor="as-every">Minutes between checks during the session</label>
                <input id="as-every" type="number" min={15} max={240} step={5} value={draft.autopilot_every_minutes}
                  disabled={draft.autopilot_mode !== "intraday"} onChange={(e) => set({ autopilot_every_minutes: e.target.value })} />
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
            {data.autopilot?.last_run && <p className="muted" style={{ fontSize: 12.5 }}>Last review: {String(data.autopilot.last_run).slice(0, 16).replace("T", " ")} UTC.</p>}
          </div>

          {msg && <div className={`note ${msg.ok ? "info" : "danger"}`} role={msg.ok ? "status" : "alert"}>{msg.text}</div>}
          <div><button className="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save assistant settings"}</button></div>
        </>
      )}
    </State>
  );
}
