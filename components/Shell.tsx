"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { clientAuth, firebaseConfigured } from "@/lib/client/firebase";
import { api } from "@/lib/api";
import { LiveProvider, useStreaming } from "@/lib/live";
import Assistant from "./Assistant";
import { ASSISTANT_SETTINGS } from "./AssistantSettings";
import { DATA_UPDATED, useApi } from "@/lib/useApi";
import {
  BookOpen, Briefcase, CandlestickChart, Check, CircleAlert, Info, Landmark, LayoutDashboard, LogOut, Menu, Moon,
  Settings, SlidersHorizontal, Sparkles, Sun, TriangleAlert, X, type LucideIcon,
} from "lucide-react";
import { SHOW_TOAST } from "@/lib/realAuto";
import InstallApp from "./InstallApp";
import MarketStrip from "./MarketStrip";
import RealAutoRunner from "./RealAutoRunner";
import WhatsNew from "./WhatsNew";
import SymbolSearch from "./SymbolSearch";

/** The owner's real brokerage account (read-only). Listed only for the sign-in the server names as its owner. */
const REAL_ACCOUNT = "/account";

/** The menu: a few entries, each a group of screens that belong together. A group's screens are one tap apart,
 *  as tabs across the top of the page (SectionTabs), so the menu itself stays short. The screens and their
 *  addresses are the ones the app always had. `also` are screens that belong to a group without being a tab in it. */
type Section = { href: string; label: string; icon: LucideIcon; tabs?: [string, string][]; also?: string[] };
const NAV: Section[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/market", label: "Market", icon: CandlestickChart, also: ["/stock"],
    tabs: [["/market", "Market"], ["/watchlist", "Watchlist"], ["/alerts", "Alerts"], ["/research", "Research & News"]] },
  { href: "/portfolio", label: "Portfolio", icon: Briefcase, tabs: [["/portfolio", "Portfolio"], ["/trades", "Trades"], ["/journal", "Journal"]] },
  { href: REAL_ACCOUNT, label: "Real account", icon: Landmark },
  { href: "/strategies", label: "Strategies", icon: SlidersHorizontal, tabs: [["/strategies", "Strategies"], ["/simulator", "Simulator"]] },
  { href: "/guide", label: "Guide", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];
/** The three screens a phone keeps one thumb away, beside the assistant and the menu. */
const QUICK: [string, string, LucideIcon][] = [["/", "Home", LayoutDashboard], ["/market", "Market", CandlestickChart], ["/portfolio", "Portfolio", Briefcase]];

const clean = (path: string) => (path !== "/" ? path.replace(/\/$/, "") : path);
const sectionOf = (path: string) => NAV.find((s) => s.href === path || s.tabs?.some(([href]) => href === path) || s.also?.includes(path));

/** The screens of the group this page belongs to, as tabs across its top. Nothing for a screen that stands alone. */
function SectionTabs({ path }: { path: string }) {
  const section = NAV.find((s) => s.tabs?.some(([href]) => href === path));
  if (!section?.tabs) return null;
  return (
    <nav className="subnav" aria-label={`${section.label} screens`}>
      {section.tabs.map(([href, label]) => <Link key={href} href={href} aria-current={href === path ? "page" : undefined}>{label}</Link>)}
    </nav>
  );
}

function Logo({ size = 30 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17l5-6 4 3 8-9" /><path d="M15 5h5v5" />
      </svg>
    </span>
  );
}

/** One line across the workspace: what the data is, or what just went wrong with it. */
function Banner({ tone = "warn", title, children }: { tone?: "warn" | "info" | "danger"; title?: string; children?: React.ReactNode }) {
  const Icon = tone === "danger" ? CircleAlert : tone === "info" ? Info : TriangleAlert;
  return (
    <div className={`banner ${tone === "warn" ? "" : tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon size={15} aria-hidden="true" />
      <span>{title && <strong>{title}</strong>}{children}</span>
    </div>
  );
}

const ThemeCtx = createContext<"light" | "dark">("light");
export const useTheme = () => useContext(ThemeCtx);

/** What the server said about this sign-in and the data (GET /api/v1/status), for any screen that needs it without asking again. */
const StatusCtx = createContext<any>(null);
export const useStatus = () => useContext(StatusCtx);

const systemTheme = () => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(clientAuth(), email.trim(), password);
    } catch (err: any) {
      const code = String(err?.code || "");
      setError(
        code.includes("network") ? "Cannot reach the sign-in service. Check your connection."
          : code.includes("too-many-requests") ? "Too many attempts. Wait a few minutes and try again."
          : "Wrong email or password.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <div className="pitch">
        <div className="brand" style={{ padding: 0, color: "#fff" }}><Logo size={34} />EGX Intelligence</div>
        <div>
          <h1>Study the Egyptian market. Test ideas without risking money.</h1>
          <ul>
            <li><Check size={18} />Live prices, order-book depth and every EGX stock by sector</li>
            <li><Check size={18} />Strategies backtested on real history, after fees and slippage</li>
            <li><Check size={18} />A paper portfolio where every profit is shown gross and net</li>
          </ul>
        </div>
        <p className="fine">Trading here is on paper. A real order exists only for the brokerage account&apos;s owner, and only when they approve it.</p>
      </div>
      <div className="form">
        <form onSubmit={submit}>
          <div className="mini-brand"><Logo size={32} />EGX Intelligence</div>
          <h2>Sign in</h2>
          <p className="sub" style={{ marginBottom: 22 }}>Use the account your administrator created for you.</p>
          <div className="field"><label htmlFor="si-email">Email</label>
            <input id="si-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label htmlFor="si-pass">Password</label>
            <input id="si-pass" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {error && <div className="note danger" role="alert">{error}</div>}
          <button className="primary" type="submit" disabled={busy} style={{ width: "100%", height: 40, marginTop: 4 }}>{busy ? "Signing in…" : "Sign in"}</button>
          <p className="muted" style={{ fontSize: 12, margin: "14px 0 0", textAlign: "center" }}>Paper trading. Nothing reaches a broker without the account owner&apos;s approval.</p>
        </form>
      </div>
    </div>
  );
}

/** Nothing below this renders, and no request is made, until somebody is signed in. */
export default function Shell({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(firebaseConfigured ? undefined : null);
  useEffect(() => {
    if (!firebaseConfigured) return;
    return onAuthStateChanged(clientAuth(), setUser);
  }, []);
  // The installed app's "no connection" page (public/sw.js). It keeps no copy of the app or its data.
  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  if (firebaseConfigured && user === undefined)
    return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }} aria-busy="true" aria-label="Loading"><Logo size={44} /></div>;
  if (firebaseConfigured && !user) return <SignIn />;
  return <Frame email={user?.email ?? null}>{children}</Frame>;
}

/** Fired on `window` to open the assistant's panel on the conversation saved in local storage. */
const OPEN_ASSISTANT = "egx:open-assistant";

let feedUpdateStarted = false; // once per page load, however many times the shell re-renders

/** Pulls the day's prices from the feed in short batches and says what it is doing. */
export function useFeedUpdate() {
  const [state, setState] = useState<{ running: boolean; left?: number; total?: number; error?: string; done?: boolean; changed?: number; paused?: boolean;
    skipped?: number; reason?: string }>({ running: false });
  const run = async () => {
    setState({ running: true });
    let failures = 0;
    let changed = 0;
    let pauses = 0;
    let seen: { left?: number; total?: number } = {};
    // The feed limits how many requests it takes per minute. When it says so, wait as long as it
    // asks and carry on from where the update stopped; what was already saved stays saved.
    const pause = async (seconds?: number) => {
      if (++pauses > 8) return false;
      setState({ running: true, ...seen, paused: true });
      await new Promise((r) => setTimeout(r, Math.min(Math.max(seconds ?? 60, 5), 120) * 1000));
      return true;
    };
    for (let i = 0; i < 90; i++) {
      try {
        const r = await api("/api/v1/data/refresh", { method: "POST" });
        failures = 0;
        changed += r.updated;
        seen = { left: r.remaining, total: r.total };
        // `failed`: stocks the feed would not give this time. They are set aside and asked for again later;
        // the update is over for everything else.
        if (r.remaining === 0) return setState({ running: false, done: true, total: r.total, changed, skipped: r.failed || 0, reason: r.errors?.[0] });
        if (r.rate_limited) {
          if (await pause(r.retry_after)) continue;
          return setState({ running: false, done: true, total: r.total, changed }); // the next scheduled check picks it up
        }
        if (r.stalled) return setState({ running: false, error: r.errors?.[0] ?? "The data feed returned nothing." });
        setState({ running: true, left: r.remaining, total: r.total });
      } catch (e: any) {
        if (e.status === 429 || /rate limit/i.test(e.message ?? "")) {
          if (await pause()) continue;
          return setState({ running: false, done: true, changed });
        }
        // One slow batch is not a failure: whatever it saved is kept, so try the next one.
        // (A database that has used up its day says so with 503: asking again would only be refused again.)
        const transient = [0, 502, 503, 504].includes(e.status) && !/rejected|rate limit|could not be read|usage limit/i.test(e.message);
        if (!transient || ++failures >= 3) {
          const text = e.status === 504 ? "The data feed is answering too slowly right now. Try again in a few minutes." : e.message;
          return setState({ running: false, error: text });
        }
      }
    }
    setState({ running: false, error: "The update is taking too long. Try again later." });
  };
  return { state, run };
}

const RECHECK_MS = 15 * 60 * 1000;
const LIVE_MS = 15 * 1000;
/** While prices stream in, the figures the server works out (portfolio value, breadth) are re-read this often. */
const REREAD_STREAMING_MS = 60 * 1000;
let skippedTold = 0; // the count last told about, so the same note is not shown again on every re-check

function FeedUpdater({ provider }: { provider: any }) {
  const { state, run } = useFeedUpdate();
  const [notice, setNotice] = useState(false);
  const [skipNote, setSkipNote] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const first = provider.with_history === 0;
  const streaming = useRef(false);
  streaming.current = useStreaming();
  const reread = useRef(0);
  const running = useRef(false);
  running.current = state.running;

  // Once when the page opens if the data is not from today, then every 15 minutes
  // while the tab is open and visible, so prices stay current through a session.
  useEffect(() => {
    if (provider.refresh_due && !feedUpdateStarted) {
      feedUpdateStarted = true;
      run();
    }
    const timer = setInterval(() => {
      if (!running.current && document.visibilityState === "visible") run();
    }, RECHECK_MS);
    return () => clearInterval(timer);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // While the market is open: the latest price of every stock, every 15 seconds.
  const open = useRef(false);
  open.current = !!provider.market_open;
  useEffect(() => {
    const poll = async () => {
      if (!open.current || document.visibilityState !== "visible") return;
      try {
        const r = await api("/api/v1/data/live", { method: "POST" });
        setLiveError(null);
        // Every screen re-reads on this. While the stream is live the prices on screen already move with each
        // trade, so the re-read (which costs the database reads) is only for the figures worked out on the
        // server, and once a minute is enough for them. Without the stream it is what moves the prices: every time.
        if (r.updated && (!streaming.current || Date.now() - reread.current >= REREAD_STREAMING_MS)) {
          reread.current = Date.now();
          window.dispatchEvent(new Event(DATA_UPDATED));
        }
      } catch (e: any) {
        // One missed minute is not worth an alarm; say so only when the feed itself reports a problem.
        setLiveError(e.status === 502 ? e.message : null);
      }
    };
    poll();
    const timer = setInterval(poll, LIVE_MS);
    return () => clearInterval(timer);
  }, []);

  // New data saved: tell every screen to re-read it. No reload, nothing to click.
  useEffect(() => {
    if (!state.done || !state.changed) return; // a check that found nothing new changes nothing on screen
    window.dispatchEvent(new Event(DATA_UPDATED));
    setNotice(true);
    const t = setTimeout(() => setNotice(false), 4000);
    return () => clearTimeout(t);
  }, [state.done, state.changed]);

  // Some stocks were set aside: said once for a while, and again only when their number changes.
  useEffect(() => {
    if (!state.done || !state.skipped || state.skipped === skippedTold) return;
    skippedTold = state.skipped;
    setSkipNote(true);
    const t = setTimeout(() => setSkipNote(false), 12000);
    return () => clearTimeout(t);
  }, [state.done, state.skipped]);

  if (state.running && state.paused)
    return (
      <Banner tone="info" title="The data feed asked for a short pause.">
        The update continues by itself in about a minute
        {state.total && state.left != null ? ` (${state.total - state.left} of ${state.total} stocks done)` : ""}. Prices already saved stay on screen.
      </Banner>
    );
  if (state.running && (first || (state.left ?? 0) > 0))
    return (
      <Banner tone="info" title={first ? "Loading market data for the first time." : "Updating market data."}>
        {state.total ? `${state.total - (state.left ?? state.total)} of ${state.total} stocks…` : "Contacting Younit…"}
        {first ? " This takes a minute or two; keep the page open." : ""}
      </Banner>
    );
  if (state.error)
    return <Banner tone="danger" title="Market data was not updated.">{state.error}</Banner>;
  if (skipNote && state.skipped)
    return (
      <Banner title={`${state.skipped} stock${state.skipped === 1 ? "" : "s"} could not be updated.`}>
        {state.reason ? `${state.reason}. ` : ""}The feed is asked for {state.skipped === 1 ? "it" : "them"} again in half an hour. Every other stock is up to date.
      </Banner>
    );
  if (notice) return <Banner tone="info">Market data updated.</Banner>;
  if (liveError) return <Banner title="Live prices are not coming through.">{liveError} Showing the last saved prices.</Banner>;
  return null;
}

type Toast = { seq: number | string; message: string; note?: string; symbol?: string | null; title?: string; chat?: string };
const AUTOPILOT_MS = 3 * 60 * 1000;
const CHECK_MS = 30 * 1000;

/** Work that follows the data: bring automatic paper runs up to date and check the alerts.
 *  Both are no-ops on the server when there is nothing to do. */
function Background() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    let busy = false, last = 0, stopped = false;
    let autopilot = true, lastAuto = 0;   // asked once; the server answers "off" unless the user enabled it
    const onSettings = () => { autopilot = true; lastAuto = 0; };
    window.addEventListener(ASSISTANT_SETTINGS, onSettings);
    const work = async (force = false) => {
      if (busy || stopped || document.visibilityState !== "visible") return;
      if (!force && Date.now() - last < 12000) return;
      busy = true;
      last = Date.now();
      try {
        const runs = await api("/api/v1/paper-runs/process", { method: "POST" });
        const sold: any[] = runs.orders ?? [];   // stop-loss / take-profit orders the app just carried out
        if (runs.fills > 0 || sold.length) window.dispatchEvent(new Event(DATA_UPDATED));
        if (sold.length && !stopped) {
          setToasts((t) => [...sold.map((o) => ({ seq: `order-${o.id}`, title: "Order filled", message: o.message, symbol: o.symbol })), ...t].slice(0, 5));
        }
        // The alerts come first: one that wakes the assistant is handed to its review in this same round.
        const out = await api("/api/v1/alerts/check", { method: "POST" });
        if (out.wake) lastAuto = 0;
        if (out.triggered.length && !stopped) {
          setToasts((t) => [...out.triggered, ...t].slice(0, 5));
          // The server tells the devices that have notifications on; without one, the browser's own notice does.
          if (!out.pushed && typeof Notification !== "undefined" && Notification.permission === "granted") {
            for (const e of out.triggered) new Notification("EGX Intelligence alert", { body: e.message + (e.note ? ` — ${e.note}` : "") });
          }
        }
        // The assistant's own review, when the user switched the autopilot on. The server decides whether one is due:
        // after a close, at the schedule, or because something the app was watching for it has happened.
        if (autopilot && Date.now() - lastAuto > AUTOPILOT_MS) {
          lastAuto = Date.now();
          const review = await api("/api/v1/assistant/autopilot", { method: "POST" });
          if (review.mode === "off") autopilot = false;
          // Something the app saw waits for it (the pause after its last review is not over): ask again in a minute.
          if (review.waiting > 0 && !review.ran && !review.blocked && (review.mode === "events" || review.mode === "intraday")) lastAuto = Date.now() - AUTOPILOT_MS + 60_000;
          if (review.ran && !stopped) {
            if (review.changes > 0) window.dispatchEvent(new Event(DATA_UPDATED));
            const did = `${review.changes} change${review.changes === 1 ? "" : "s"}`;
            setToasts((t) => [{ seq: `auto-${review.chat}`, title: review.account === "real" ? "Autopilot · real account" : "Autopilot", chat: review.chat,
                                message: review.error ? `The review stopped: ${review.error}`
                                  : review.reason === "event" ? `Woken by what it was watching: ${did}.`
                                  : `Reviewed the ${review.account === "real" ? "real account" : "portfolio"}: ${did}.`,
                                note: review.error ? undefined : review.summary?.slice(0, 180) }, ...t].slice(0, 5));
          }
        }
      } catch {
        // background work never interrupts the screen; it simply tries again later
      } finally {
        busy = false;
      }
    };
    work(true);
    const onData = () => work();
    const onToast = (e: Event) => { if (!stopped) setToasts((t) => [(e as CustomEvent).detail as Toast, ...t.filter((x) => x.seq !== (e as CustomEvent).detail.seq)].slice(0, 5)); };
    window.addEventListener(SHOW_TOAST, onToast);
    window.addEventListener(DATA_UPDATED, onData);
    const timer = setInterval(() => work(), CHECK_MS);
    return () => {
      stopped = true;
      window.removeEventListener(DATA_UPDATED, onData);
      window.removeEventListener(SHOW_TOAST, onToast);
      window.removeEventListener(ASSISTANT_SETTINGS, onSettings);
      clearInterval(timer);
    };
  }, []);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="alert" aria-live="assertive">
      {toasts.map((t) => (
        <div className="toast" key={t.seq}>
          <div><strong>{t.title ?? "Alert"}</strong> · {t.message}{t.note ? <span className="muted" dir="auto"> — {t.note}</span> : null}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            {t.symbol && <Link className="btn small" href={`/stock?symbol=${t.symbol}`}>Open {t.symbol}</Link>}
            {t.chat && <button className="small" onClick={() => {
              try { localStorage.setItem("egx-assistant-chat", t.chat!); localStorage.setItem("egx-assistant-open", "1"); } catch {}
              window.dispatchEvent(new Event(OPEN_ASSISTANT));
              setToasts((all) => all.filter((x) => x.seq !== t.seq));
            }}>Read the review</button>}
            <button className="small" onClick={() => setToasts((all) => all.filter((x) => x.seq !== t.seq))}>Dismiss</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Frame({ children, email }: { children: React.ReactNode; email: string | null }) {
  const path = clean(usePathname());
  const here = sectionOf(path);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [assistant, setAssistant] = useState(false);
  const [assistantKey, setAssistantKey] = useState(0);
  useEffect(() => {
    try { setAssistant(localStorage.getItem("egx-assistant-open") === "1"); } catch {}
    const onOpen = () => { setAssistant(true); setAssistantKey((k) => k + 1); };   // re-mount on the requested conversation
    window.addEventListener(OPEN_ASSISTANT, onOpen);
    return () => window.removeEventListener(OPEN_ASSISTANT, onOpen);
  }, []);
  const assistantButton = useRef<HTMLButtonElement>(null);   // in the top bar
  const assistantTab = useRef<HTMLButtonElement>(null);      // in the phone's bar at the bottom
  const showAssistant = (on: boolean) => {
    setAssistant(on);
    try { localStorage.setItem("egx-assistant-open", on ? "1" : "0"); } catch {}
    // closing hands the keyboard back to where the panel was opened from: whichever of the two buttons is on screen
    if (!on) (assistantButton.current?.offsetParent ? assistantButton.current : assistantTab.current)?.focus();
  };
  const { data: status, error, status: httpStatus } = useApi("/api/v1/status");

  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as "light" | "dark") || systemTheme());
  }, []);
  useEffect(() => setOpen(false), [path]);
  // The phone's status bar takes the top bar's colour in the theme actually shown, which the switch can set apart from the system's.
  useEffect(() => {
    const colour = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
    if (colour) document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", colour));
  }, [theme]);
  // the phone menu closes on Escape, like any other layer over the page
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
    setTheme(next);
  };

  const d = status?.data;
  // Signed in to Firebase, but the server refused the account: say so once, plainly,
  // instead of rendering every screen full of the same error.
  if (email && httpStatus === 401) {
    return (
      <main style={{ maxWidth: 440, margin: "14vh auto", padding: "0 16px" }}>
        <div className="card" style={{ padding: 24 }}>
          <Logo size={36} />
          <h1 style={{ marginTop: 14 }}>No access</h1>
          <p style={{ margin: "10px 0 16px" }}>
            <strong>{email}</strong> is not allowed to use EGX Intelligence. The account may have been deactivated, or it was never
            given access. Ask the administrator.
          </p>
          <button className="primary" onClick={() => signOut(clientAuth())}>Sign out</button>
        </div>
      </main>
    );
  }
  return (
    <ThemeCtx.Provider value={theme}>
      <StatusCtx.Provider value={status}>
      <LiveProvider enabled={!!status?.provider?.configured && !!status?.provider?.market_open}>
      <div className={`shell ${assistant ? "with-assistant" : ""}`}>
        <aside className={`side ${open ? "open" : ""}`}>
          <div className="brand">
            <Logo />
            <span>EGX Intelligence<small>Analysis &amp; paper trading</small></span>
            <button className="close-nav icon-btn ghost" onClick={() => setOpen(false)} aria-label="Close menu"><X size={18} /></button>
          </div>
          <nav className="nav" aria-label="Main">
            {NAV.filter((s) => s.href !== REAL_ACCOUNT || status?.real_account?.allowed).map(({ href, label, icon: Icon, tabs }) => (
              <Link key={href} href={href} className={here?.href === href ? "active" : undefined}
                aria-current={path === href ? "page" : undefined}
                title={tabs ? tabs.map(([, name]) => name).join(" · ") : undefined}>
                <Icon size={17} aria-hidden="true" />{label}
                {href === REAL_ACCOUNT && status?.real_orders?.waiting > 0 && (
                  <span className="nav-count" title="Real orders waiting for your approval">{status.real_orders.waiting}<span className="sr-only"> waiting for your approval</span></span>
                )}
              </Link>
            ))}
            <div className="nav-rule" role="presentation" />
            <WhatsNew />
            <InstallApp />
          </nav>
          <div className="side-foot">
            <span className="avatar" aria-hidden="true">{(email ?? "L")[0].toUpperCase()}</span>
            <span className="who"><strong title={email ?? undefined}>{email ?? "Local session"}</strong><span>Paper account</span></span>
            {email && (
              <button className="icon-btn ghost" onClick={() => signOut(clientAuth())} aria-label={`Sign out ${email}`} title="Sign out"><LogOut size={16} /></button>
            )}
          </div>
        </aside>
        {open && <div className="scrim" aria-hidden="true" onClick={() => setOpen(false)} />}
        <div className="main">
          <div className="topbar">
            <SymbolSearch />
            <span className="spacer" />
            {status?.provider?.configured && (
              <span className={`pill hide-sm ${status.provider.market_open ? "live" : ""}`} title="EGX trades Sunday to Thursday, 10:00 to 14:30 Cairo time">
                <span className="dot" />{status.provider.market_open ? "Market open" : "Market closed"}
              </span>
            )}
            {d && (
              <span className={`pill hide-sm ${d.mode === "sample" || d.mode === "mixed" ? "warn" : ""}`} title="Where the prices on screen come from">
                {d.mode === "sample" ? "Sample data" : d.mode === "mixed" ? "Imported + sample data" : d.mode === "imported" ? "Imported data"
                  : d.mode === "younit" ? (d.is_live ? `Live · ${String(d.live_as_of).slice(11, 16)} Cairo` : `Close of ${d.latest_bar_date}`) : "No data"}
              </span>
            )}
            <span className="pill paper hide-sm" title="Orders placed from these screens are simulated. Real orders are separate, on the Real account page.">Paper trading</span>
            {status?.real_orders?.auto ? (
              <Link className="pill auto" href={REAL_ACCOUNT}
                title={`Automatic orders are on: during the session, ${status.real_orders.background ? "with the app open or closed" : "while this app is open"}, what fits your box is sent to the broker without asking you. Open the Real account page to stop it.`}>
                <span className="dot" /><span className="hide-sm">Automatic real orders on{status.real_orders.waiting > 0 ? ` · ${status.real_orders.waiting} waiting` : ""}</span>
                <span className="only-sm">Auto on</span>
              </Link>
            ) : status?.real_orders?.ready && (
              <Link className="pill warn hide-sm" href={REAL_ACCOUNT} title="Real orders are switched on for this sign-in. Each one is sent only after you approve it.">
                Real orders on{status.real_orders.waiting > 0 ? ` · ${status.real_orders.waiting} waiting` : ""}
              </Link>
            )}
            <button ref={assistantButton} className={`as-open ${assistant ? "on" : ""}`} onClick={() => showAssistant(!assistant)} aria-expanded={assistant}
              aria-label="Assistant" title="Ask the assistant, or tell it what to do">
              <Sparkles size={15} aria-hidden="true" /><span>Assistant</span>
            </button>
            <button className="icon-btn ghost" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Theme">
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
          <MarketStrip />
          {error && <Banner tone="danger">{error}</Banner>}
          {d?.has_sample_data && (
            <Banner title="Sample data.">
              {d.mode === "mixed" ? "Some stocks still show" : "Prices shown are"} synthetic, generated for testing. They
              are not EGX market quotes. Import real history in <Link href="/settings?tab=data">Settings</Link>.
            </Banner>
          )}
          {status?.provider?.configured && <FeedUpdater provider={status.provider} />}
          <Background />
          {status?.real_orders?.auto && <RealAutoRunner marketOpen={!!status?.provider?.market_open} />}
          {d && !d.has_sample_data && d.is_stale && (
            <Banner title="Stale data.">
              Latest bar is {d.latest_bar_date} ({d.trading_days_behind} sessions behind). These are not live prices.
            </Banner>
          )}
          <main className="content"><SectionTabs path={path} />{children}</main>
          <footer className="foot">
            <span>Figures are for study, not investment advice. Trading is on paper; a real order needs the account owner&apos;s approval, of that order or given in advance.</span>
            <span>Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a> Lightweight Charts</span>
          </footer>
        </div>
        {/* On a phone the menu is a thumb away: the three screens used most, the assistant, and the rest behind "Menu". */}
        <nav className="tabbar" aria-label="Quick">
          {QUICK.map(([href, label, Icon]) => (
            <Link key={href} href={href} className={here?.href === href ? "active" : undefined} aria-current={path === href ? "page" : undefined}>
              <Icon size={20} aria-hidden="true" /><span>{label}</span>
            </Link>
          ))}
          <button ref={assistantTab} className={assistant ? "active" : undefined} onClick={() => showAssistant(!assistant)} aria-expanded={assistant}>
            <Sparkles size={20} aria-hidden="true" /><span>Assistant</span>
          </button>
          <button className={open ? "active" : undefined} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? "Close menu" : "Open menu"}>
            <Menu size={20} aria-hidden="true" /><span>Menu</span>
            {status?.real_orders?.waiting > 0 && <span className="tab-dot" aria-hidden="true" />}
          </button>
        </nav>
        <Assistant key={assistantKey} open={assistant} onClose={() => showAssistant(false)} />
      </div>
      </LiveProvider>
      </StatusCtx.Provider>
    </ThemeCtx.Provider>
  );
}
