"use client";
import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Info, Landmark, Power, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { useStatus } from "@/components/Shell";
import { State } from "@/components/ui";

/** Fired on `window` when the assistant's settings were saved, so the background job re-reads them. */
export const ASSISTANT_SETTINGS = "egx:assistant-settings";

const ACCESS: Record<string, [string, string]> = {
  full: ["Full access", "Carries out what you ask straight away, trades and deletions included. The only setting with which it trades by itself."],
  confirm: ["Ask me first", "Shows each trade, run change, deletion or settings change and waits for your approval. By itself it then only looks and reports."],
  read: ["Look only", "Answers and reads your data, but changes nothing."],
};
const EFFORT: Record<string, string> = {
  low: "Low: quickest and cheapest", medium: "Medium: balanced (recommended)", high: "High: thinks longer",
  xhigh: "Extra high: for hard analysis", max: "Maximum: slowest, most expensive",
};
/** When the autopilot reviews: the name, what it means, and whether it is the one to start with. */
const SCHEDULE: Record<string, [string, string, boolean?]> = {
  after_close: ["After each close", "One review of the portfolio and the market after every completed session. The cheapest."],
  events: ["When a watch fires", "The review after each close, plus a short one whenever something the app is watching for it happens: a level it set, a time, a stop-loss sold. The app does the watching at no cost.", true],
  intraday: ["During the session too", "The review after each close, plus a check every so many minutes while the market is open, and a short one when a watch fires. The most thorough, and the most expensive."],
};
/** What the autopilot works on by itself: the name and what it means. "off" is the autopilot switched off. */
const TARGET: Record<string, [string, string]> = {
  off: ["Off", "The assistant acts only when you ask it to."],
  paper: ["Paper portfolio", "It trades the paper (practice) portfolio by itself, inside your limits. No real money, whatever your instructions say."],
  real: ["Real account", "Its reviews are about your real brokerage account: it reads it and writes real orders, inside your limits. It leaves the paper portfolio as it is."],
  both: ["Both", "It trades the paper portfolio, and writes real orders only when your instructions below ask for them."],
};
const LANGUAGE: Record<string, [string, string]> = {
  auto: ["The language I write in", "Arabic when you write Arabic, English when you write English."],
  ar: ["Always Arabic (Egyptian)", "Answers in Egyptian Arabic whatever language you write in. Symbols and screen names stay as they are."],
  en: ["Always English", "Answers in English whatever language you write in."],
};
/** What it is doing by itself now, as saved: the words on the status line and its colour. Red is real money moving without the owner. */
const LEVEL: Record<string, [string, string]> = {
  off: ["Off", ""], paper: ["On · paper portfolio", "on"], looks: ["On · it only looks and reports", "warn"], held: ["Held back", "warn"],
  blocked: ["Not running", "warn"], proposals: ["On · real orders wait for your approval", "warn"], automatic: ["On · real orders are sent without you", "real"],
};
const usd = (v: unknown) => `$${Number(v ?? 0).toFixed(2)}`;
const NUMBERS = ["daily_usd", "monthly_usd", "max_trade_pct", "max_position_pct", "min_cash_pct", "max_trades_per_day", "autopilot_every_minutes",
                 "real_proposals_per_day", "autopilot_max_per_day"];

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

/** One choice out of a few, each said in a line: radio buttons, so the keyboard and a screen reader get them for free. */
function Pick({ name, legend, value, options, onPick }: {
  name: string; legend: string; value: string; onPick: (v: string) => void;
  options: { value: string; title: string; about: string; badge?: React.ReactNode; disabled?: boolean }[];
}) {
  return (
    <fieldset className="pick">
      <legend>{legend}</legend>
      <div className="choices">
        {options.map((o) => (
          <label className="choice" key={o.value}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onPick(o.value)} />
            <strong>{o.title}{o.badge}</strong>
            {o.about}
          </label>
        ))}
      </div>
    </fieldset>
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
  const [saved, setSaved] = useState("");   // the draft as the server holds it, to say whether anything is unsaved
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const lastMode = useRef("events");        // the schedule to come back to when the autopilot is switched on again
  const live = useStatus()?.real_orders;   // whether this sign-in is the brokerage account's owner, and what is switched on
  useEffect(() => {
    const s = data?.settings;
    if (!s) return;
    const d = { model: s.model, effort: s.effort, access: s.access, daily_usd: s.daily_usd, monthly_usd: s.monthly_usd,
                language: s.language, instructions: s.instructions, real_proposals_per_day: s.real_proposals_per_day, ...s.limits,
                autopilot_mode: s.autopilot.mode, autopilot_account: s.autopilot.account ?? "both", autopilot_every_minutes: s.autopilot.every_minutes,
                autopilot_mandate: s.autopilot.mandate, autopilot_max_per_day: s.autopilot.max_per_day, autopilot_notify: s.autopilot.notify };
    if (d.autopilot_mode !== "off") lastMode.current = d.autopilot_mode;
    setDraft(d);
    setSaved(JSON.stringify(d));
  }, [data]);

  /** Save the page as it stands, with `patch` on top: a one-tap fix from the checklist saves at once. */
  const save = async (patch: any = {}) => {
    const next = { ...draft, ...patch };
    // An emptied field is not a zero: zero means "no ceiling" or "no proposals", which must be typed on purpose.
    if (NUMBERS.some((k) => String(next[k] ?? "").trim() === "" || !Number.isFinite(Number(next[k])))) {
      setMsg({ ok: false, text: "Fill in every number on this page. Where none is wanted, write 0." });
      return;
    }
    setBusy(true); setMsg(null);
    try {
      const body = { ...next };
      for (const k of NUMBERS) body[k] = Number(body[k]);
      await api("/api/v1/assistant/settings", { method: "PUT", json: body });
      setMsg({ ok: true, text: "Saved. It applies from the assistant's next reply or review." });
      window.dispatchEvent(new Event(ASSISTANT_SETTINGS));
      reload();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: any) => { setMsg(null); setDraft((d: any) => ({ ...d, ...patch })); };
  // "Saved" is said for a moment and then steps out of the way; a failure stays until it is dealt with
  useEffect(() => {
    if (!msg?.ok) return;
    const t = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(t);
  }, [msg]);
  const model = data?.models?.find((m: any) => m.id === draft?.model);
  const spend = data?.spending;
  const own = data?.self_trading;           // what is in place for it to trade by itself, as saved (the server's own list)
  const owner = !!live?.allowed;
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  const on = !!draft && draft.autopilot_mode !== "off";
  // The real account is its owner's alone: only they choose it. Someone left on it without the account can still leave it.
  const target = !draft ? "off" : !on ? "off" : owner ? draft.autopilot_account : draft.autopilot_account === "real" ? "real" : "paper";
  const pickTarget = (t: string) => {
    if (t === "off") {
      if (on) lastMode.current = draft.autopilot_mode;
      return set({ autopilot_mode: "off" });
    }
    set({ autopilot_mode: on ? draft.autopilot_mode : lastMode.current,
          autopilot_account: owner || draft.autopilot_account === "real" ? t : draft.autopilot_account });
  };
  const withReal = owner && on && draft.autopilot_account !== "paper";
  const [levelName, levelTone] = LEVEL[own?.level] ?? LEVEL.off;

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
            <div className="card-head"><h2>Trading by itself</h2>
              {own && <span className={`badge ${own.missing ? "warn" : own.level === "off" ? "" : "ok"}`}>{own.level === "off" ? "off" : own.missing ? `${own.missing} to do` : "all set"}</span>}</div>
            <p className="lead">
              The autopilot: the assistant reviews and acts without being asked, inside the limits on this page. Each review is a conversation you can read
              afterwards, and each one uses the API (typically a few cents to a few tens of cents, depending on the model).
            </p>
            {own && (
              <div className={`status-line ${levelTone}`} role="status">
                <span className="lamp" aria-hidden="true">{own.level === "off" ? <Power size={18} /> : own.level === "automatic" || own.level === "proposals" ? <Landmark size={18} /> : <Sparkles size={18} />}</span>
                <div className="say"><strong>{levelName}</strong><span>{own.headline}</span></div>
              </div>
            )}

            <Pick name="as-target" legend="What it works on by itself" value={target} onPick={pickTarget}
              options={(owner ? ["off", "paper", "real", "both"] : target === "real" ? ["off", "paper", "real"] : ["off", "paper"]).map((t) => ({
                value: t, title: TARGET[t][0], about: TARGET[t][1], disabled: !owner && t === "real" && target !== "real",
                badge: t === "real" || t === "both" ? <span className="badge warn">real money</span> : undefined }))} />

            {on && (
              <>
                <Pick name="as-when" legend="When it reviews" value={draft.autopilot_mode} onPick={(m) => set({ autopilot_mode: m })}
                  options={(data.autopilot_modes as string[]).filter((m) => m !== "off").map((m) => ({
                    value: m, title: SCHEDULE[m]?.[0] ?? m, about: SCHEDULE[m]?.[1] ?? "",
                    badge: SCHEDULE[m]?.[2] ? <span className="badge paper">recommended</span> : undefined }))} />
                <div className="grid cols-2">
                  {draft.autopilot_mode === "intraday" && (
                    <div className="field">
                      <label htmlFor="as-every">Minutes between checks during the session</label>
                      <input id="as-every" type="number" min={15} max={240} step={5} value={draft.autopilot_every_minutes} onChange={(e) => set({ autopilot_every_minutes: e.target.value })} />
                    </div>
                  )}
                  <div className="field">
                    <label htmlFor="as-reviews">Most reviews in one day</label>
                    <input id="as-reviews" type="number" min={1} max={48} value={draft.autopilot_max_per_day} aria-describedby="as-reviews-about" onChange={(e) => set({ autopilot_max_per_day: e.target.value })} />
                    <p className="foot-note" id="as-reviews-about" style={{ marginTop: 6 }}>Each review costs money: this bounds a day whatever the schedule. The review after the close is one of them and always runs.</p>
                  </div>
                </div>
              </>
            )}

            {withReal && live.ready && Number(draft.real_proposals_per_day) > 0 && (
              live.auto
                ? <div className="note danger"><strong>Real money, without you.</strong> Automatic orders are on: a real order the autopilot decides on, and that fits the box you set, is sent to the broker without you seeing it first. One that does not fit waits for your approval.</div>
                : <div className="note info">On the real account the autopilot only writes proposals. Each one waits for your approval on the <Link href="/account">Real account</Link> page: nothing is sent by itself.</div>
            )}

            {own && (
              <>
                <h3 className="sec">What is in place</h3>
                <ul className="checks">
                  {own.rows.map((r: any) => (
                    <li key={r.key} className={`${r.state === "ok" ? "ok" : r.state === "missing" ? "todo" : "fyi"} ${r.state !== "ok" && (r.fix || r.href) ? "act" : ""}`}>
                      {r.state === "ok" ? <CircleCheck size={16} aria-label="In place" /> : r.state === "missing" ? <CircleAlert size={16} aria-label="To do" /> : <Info size={16} aria-label="Good to know" />}
                      <div><strong>{r.title}</strong><span>{r.detail}</span></div>
                      {r.state !== "ok" && r.fix === "access" && <button className="small do" disabled={busy} onClick={() => save({ access: "full" })}>Give Full access</button>}
                      {r.state !== "ok" && r.href && <Link className="btn small do" href={r.href}>Set up</Link>}
                    </li>
                  ))}
                </ul>
                <p className="foot-note">
                  {dirty ? "This list shows what is saved. Save your changes to bring it up to date." : "Every step here is yours to take: the assistant cannot switch any of them on."}
                  {data.autopilot?.last_run ? ` Last review: ${String(data.autopilot.last_run).slice(0, 16).replace("T", " ")} UTC.` : ""}
                </p>
              </>
            )}
          </div>

          <div className="card">
            <h2>What you tell it</h2>
            <div className="field">
              <label htmlFor="as-mandate">Its brief for trading by itself: goals, style, what to avoid. Arabic or English.</label>
              <textarea id="as-mandate" dir="auto" rows={5} maxLength={4000} value={draft.autopilot_mandate} onChange={(e) => set({ autopilot_mandate: e.target.value })}
                placeholder="e.g. Trade only liquid stocks in an uptrend. Risk at most 1% of the portfolio per trade. Hold no more than five positions." />
              <p className="foot-note" style={{ marginTop: 6 }}>Read at the start of every review it makes by itself. Without one it manages prudently: liquid stocks, small losses, few trades.</p>
            </div>
            <div className="field">
              <label htmlFor="as-inst">Your standing instructions, for every conversation as well. Arabic or English.</label>
              <textarea id="as-inst" dir="auto" rows={3} maxLength={2000} value={draft.instructions} onChange={(e) => set({ instructions: e.target.value })}
                placeholder="e.g. Keep answers short. Always give the stop-loss with any idea. I only trade banks and real estate." />
              <p className="foot-note" style={{ marginTop: 6 }}>They change how it works and answers, not what the app lets it do: the limits below still hold.</p>
            </div>
            <div className="grid cols-2">
              <div className="field">
                <label htmlFor="as-lang">Language it answers in</label>
                <select id="as-lang" value={draft.language} onChange={(e) => set({ language: e.target.value })}>
                  {(data.languages ?? ["auto", "ar", "en"]).map((l: string) => <option key={l} value={l}>{LANGUAGE[l]?.[0] ?? l}</option>)}
                </select>
                <p className="foot-note" style={{ marginTop: 6 }}>{LANGUAGE[draft.language]?.[1]}</p>
              </div>
            </div>
          </div>

          <div className="card">
            <h2>How far it may go</h2>
            <Pick name="as-access" legend="What it may do" value={draft.access} onPick={(a) => set({ access: a })}
              options={(data.access_levels as string[]).map((a) => ({ value: a, title: ACCESS[a]?.[0] ?? a, about: ACCESS[a]?.[1] ?? "" }))} />
            <p className="foot-note" style={{ marginTop: -6 }}>This is about the paper portfolio and your notes. It never manages sign-in accounts, and it cannot approve or cancel a real order.</p>

            <h3 className="sec">Limits on its own paper trades</h3>
            <p className="lead" style={{ margin: "0 0 12px" }}>Checked by the app on every paper trade the assistant places, whatever it was asked. A trade outside them is refused and it is told why. Trades you place yourself are not affected.</p>
            <div className="grid cols-4">
              {LIMITS.map(([key, label, unit, min, max]) => (
                <div className="field" key={key}>
                  <label htmlFor={`as-${key}`}>{label}</label>
                  <input id={`as-${key}`} type="number" min={min} max={max} value={draft[key]} aria-describedby={`as-${key}-unit`} onChange={(e) => set({ [key]: e.target.value })} />
                  <p className="foot-note" id={`as-${key}-unit`} style={{ marginTop: 6 }}>{unit}</p>
                </div>
              ))}
            </div>

            {owner && (
              <>
                <h3 className="sec">Real money <span className={`badge ${live.auto ? "bad" : live.ready ? "warn" : ""}`} style={{ marginLeft: 6, textTransform: "none", letterSpacing: 0 }}>{live.auto ? "automatic orders on" : live.ready ? "proposals only" : "real orders off"}</span></h3>
                <p className="lead" style={{ margin: "0 0 12px" }}>
                  The assistant can only <em>propose</em> a real order. A proposal goes to the broker when you approve it or, with automatic orders on, by itself when it
                  fits the box you set: the stocks, the most per order, the most in one day, the budget. Those money limits are in <Link href="/settings?tab=real">Real trading</Link>.
                </p>
                <div className="grid cols-2">
                  <div className="field">
                    <label htmlFor="as-props">Real-order proposals it may write in one day (0 for none)</label>
                    <input id="as-props" type="number" min={0} max={50} value={draft.real_proposals_per_day} aria-describedby="as-props-about" onChange={(e) => set({ real_proposals_per_day: e.target.value })} />
                    <p className="foot-note" id="as-props-about" style={{ marginTop: 6 }}>With 0 it reads the real account but writes no proposal at all.</p>
                  </div>
                  <div className="field">
                    <span className="label-like">After a review it made by itself</span>
                    <label className="check" style={{ marginTop: 6 }}>
                      <input type="checkbox" checked={!!draft.autopilot_notify} onChange={(e) => set({ autopilot_notify: e.target.checked })} />
                      <span>Tell my devices when it changed something</span>
                    </label>
                    <p className="foot-note" style={{ marginTop: 6 }}>Needs notifications switched on for the device (Real trading → Running without the app open). The notice gives the number of changes only; a review that stops with an error is always told.</p>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="card">
            <h2>Model and cost</h2>
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
            </div>

            <h3 className="sec">What it costs</h3>
            <p className="lead" style={{ margin: "0 0 12px" }}>
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
            {spend?.autopilot?.reviews_a_day > 0 && (
              <div className="note info" style={{ marginBottom: 0 }}>
                <strong>What a day of the autopilot can cost.</strong>{" "}
                {spend.autopilot.mode === "events"
                  ? <>The schedule saved now runs one review after the close, and a short one each time something it watches for happens: at most {spend.autopilot.reviews_at_most} a day in all.</>
                  : <>The schedule saved now runs at most {spend.autopilot.reviews_a_day} review{spend.autopilot.reviews_a_day === 1 ? "" : "s"} a day by the clock{spend.autopilot.reviews_at_most > spend.autopilot.reviews_a_day ? <>, and up to {spend.autopilot.reviews_at_most} when its watches wake it too</> : null}.</>}{" "}
                {spend.autopilot.reviews_asked > spend.autopilot.reviews_a_day && <>It asks for about {spend.autopilot.reviews_asked}, and your limit for one day holds the rest back: the last checks of the session will not run (the review after the close always does).{" "}</>}
                {spend.autopilot.review_usd != null
                  ? <>{spend.autopilot.reviews_counted === 1 ? "Your one review this week cost" : `Your ${spend.autopilot.reviews_counted} reviews this week cost on average`} about {usd(spend.autopilot.review_usd)}
                    {spend.autopilot.mode === "events"
                      ? <>; on the days it ran, about <strong>{usd(spend.autopilot.usual_day_usd)} a day</strong>.</>
                      : <>, so about <strong>{usd(spend.autopilot.day_usd)} a day</strong>.</>}</>
                  : <>No review has run in the last week, so there is no figure of your own yet.</>}{" "}
                {Number(spend.daily_limit_usd) > 0
                  ? <>It can never pass your daily ceiling of {usd(spend.daily_limit_usd)}, conversations included: at the ceiling it stops reviewing and proposing until the next day.</>
                  : <>There is no daily ceiling: set one above to bound it.</>}{" "}
                Watching stop-losses and sending what was already decided is the app&apos;s own work and costs nothing here.
              </div>
            )}
          </div>

          {msg && !msg.ok && <div className="note danger" role="alert">{msg.text}</div>}
          {/* in reach however long the page is, and out of the way when there is nothing to save */}
          {(dirty || busy || msg?.ok) && (
            <div className={`savebar ${dirty ? "" : "clean"}`}>
              <span className="state" role="status"><span className="dot" aria-hidden="true" />{dirty ? "You have changes that are not saved yet." : msg?.ok ? msg.text : "Saving…"}</span>
              <button className="primary" onClick={() => save()} disabled={busy || !dirty}>{busy ? "Saving…" : "Save"}</button>
            </div>
          )}
        </>
      )}
    </State>
  );
}
