"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { clientAuth, firebaseConfigured } from "@/lib/client/firebase";
import { api } from "@/lib/api";
import { LiveProvider } from "@/lib/live";
import { DATA_UPDATED, useApi } from "@/lib/useApi";
import {
  Bell, BookOpen, Briefcase, CandlestickChart, Check, FlaskConical, LayoutDashboard, LogOut, Menu, Moon, Newspaper, NotebookPen,
  Receipt, Settings, SlidersHorizontal, Star, Sun, X, type LucideIcon,
} from "lucide-react";
import MarketStrip from "./MarketStrip";
import SymbolSearch from "./SymbolSearch";

const NAV: { label: string; items: [string, string, LucideIcon][] }[] = [
  { label: "Markets", items: [["/", "Dashboard", LayoutDashboard], ["/market", "Market", CandlestickChart], ["/watchlist", "Watchlist", Star]] },
  { label: "Trading", items: [["/portfolio", "Portfolio", Briefcase], ["/trades", "Trades", Receipt], ["/simulator", "Simulator", FlaskConical],
                             ["/strategies", "Strategies", SlidersHorizontal]] },
  { label: "Research", items: [["/research", "Research & News", Newspaper], ["/journal", "Journal", NotebookPen], ["/alerts", "Alerts", Bell],
                              ["/guide", "Guide", BookOpen]] },
  { label: "System", items: [["/settings", "Settings", Settings]] },
];

function Logo({ size = 30 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17l5-6 4 3 8-9" /><path d="M15 5h5v5" />
      </svg>
    </span>
  );
}

const ThemeCtx = createContext<"light" | "dark">("light");
export const useTheme = () => useContext(ThemeCtx);

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
        <p className="fine">Paper trading only. This application cannot send an order to a broker.</p>
      </div>
      <div className="form">
        <form onSubmit={submit}>
          <h2>Sign in</h2>
          <p className="sub" style={{ marginBottom: 20 }}>Use the account your administrator created for you.</p>
          <div className="field"><label htmlFor="si-email">Email</label>
            <input id="si-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label htmlFor="si-pass">Password</label>
            <input id="si-pass" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          {error && <div className="note danger" role="alert">{error}</div>}
          <button className="primary" type="submit" disabled={busy} style={{ width: "100%", height: 40 }}>{busy ? "Signing in…" : "Sign in"}</button>
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
  if (firebaseConfigured && user === undefined)
    return <div style={{ minHeight: "100vh", display: "grid", placeItems: "center" }} aria-busy="true" aria-label="Loading"><Logo size={44} /></div>;
  if (firebaseConfigured && !user) return <SignIn />;
  return <Frame email={user?.email ?? null}>{children}</Frame>;
}

let feedUpdateStarted = false; // once per page load, however many times the shell re-renders

/** Pulls the day's prices from the feed in short batches and says what it is doing. */
export function useFeedUpdate() {
  const [state, setState] = useState<{ running: boolean; left?: number; total?: number; error?: string; done?: boolean; changed?: number }>({ running: false });
  const run = async () => {
    setState({ running: true });
    let failures = 0;
    let changed = 0;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await api("/api/v1/data/refresh", { method: "POST" });
        failures = 0;
        changed += r.updated;
        if (r.remaining === 0) return setState({ running: false, done: true, total: r.total, changed });
        if (r.stalled) return setState({ running: false, error: r.errors?.[0] ?? "The data feed returned nothing." });
        setState({ running: true, left: r.remaining, total: r.total });
      } catch (e: any) {
        // One slow batch is not a failure: whatever it saved is kept, so try the next one.
        const transient = [0, 502, 503, 504].includes(e.status) && !/rejected|rate limit|could not be read/i.test(e.message);
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

function FeedUpdater({ provider }: { provider: any }) {
  const { state, run } = useFeedUpdate();
  const [notice, setNotice] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const first = provider.with_history === 0;
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
        if (r.updated) window.dispatchEvent(new Event(DATA_UPDATED));
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

  if (state.running && (first || (state.left ?? 0) > 0))
    return (
      <div className="banner" role="status">
        <strong>{first ? "Loading market data for the first time." : "Updating market data."}</strong>{" "}
        {state.total ? `${state.total - (state.left ?? state.total)} of ${state.total} stocks…` : "Contacting Younit…"}
        {first ? " This takes a minute or two; keep the page open." : ""}
      </div>
    );
  if (state.error)
    return <div className="banner danger" role="alert"><strong>Market data was not updated.</strong> {state.error}</div>;
  if (notice) return <div className="banner" role="status">Market data updated.</div>;
  if (liveError) return <div className="banner" role="status"><strong>Live prices are not coming through.</strong> {liveError} Showing the last saved prices.</div>;
  return null;
}

type Toast = { seq: number; message: string; note?: string; symbol?: string | null };
const CHECK_MS = 30 * 1000;

/** Work that follows the data: bring automatic paper runs up to date and check the alerts.
 *  Both are no-ops on the server when there is nothing to do. */
function Background() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    let busy = false, last = 0, stopped = false;
    const work = async (force = false) => {
      if (busy || stopped || document.visibilityState !== "visible") return;
      if (!force && Date.now() - last < 12000) return;
      busy = true;
      last = Date.now();
      try {
        const runs = await api("/api/v1/paper-runs/process", { method: "POST" });
        if (runs.fills > 0) window.dispatchEvent(new Event(DATA_UPDATED));
        const out = await api("/api/v1/alerts/check", { method: "POST" });
        if (out.triggered.length && !stopped) {
          setToasts((t) => [...out.triggered, ...t].slice(0, 5));
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            for (const e of out.triggered) new Notification("EGX Intelligence alert", { body: e.message + (e.note ? ` — ${e.note}` : "") });
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
    window.addEventListener(DATA_UPDATED, onData);
    const timer = setInterval(() => work(), CHECK_MS);
    return () => { stopped = true; window.removeEventListener(DATA_UPDATED, onData); clearInterval(timer); };
  }, []);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="alert" aria-live="assertive">
      {toasts.map((t) => (
        <div className="toast" key={t.seq}>
          <div><strong>Alert</strong> · {t.message}{t.note ? <span className="muted"> — {t.note}</span> : null}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            {t.symbol && <Link className="btn small" href={`/stock?symbol=${t.symbol}`}>Open {t.symbol}</Link>}
            <button className="small" onClick={() => setToasts((all) => all.filter((x) => x.seq !== t.seq))}>Dismiss</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Frame({ children, email }: { children: React.ReactNode; email: string | null }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const { data: status, error, status: httpStatus } = useApi("/api/v1/status");

  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as "light" | "dark") || systemTheme());
  }, []);
  useEffect(() => setOpen(false), [path]);

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
      <LiveProvider enabled={!!status?.provider?.configured && !!status?.provider?.market_open}>
      <div className="shell">
        <aside className={`side ${open ? "open" : ""}`}>
          <div className="brand">
            <Logo />
            <span>EGX Intelligence<small>Analysis &amp; paper trading</small></span>
          </div>
          <nav className="nav" aria-label="Main">
            {NAV.map((group) => (
              <div key={group.label} role="group" aria-label={group.label}>
                <div className="nav-label">{group.label}</div>
                {group.items.map(([href, label, Icon]) => (
                  <Link key={href} href={href} aria-current={path === href || path === `${href}/` ? "page" : undefined}>
                    <Icon size={16} aria-hidden="true" />{label}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <span className="avatar" aria-hidden="true">{(email ?? "L")[0].toUpperCase()}</span>
            <span className="who"><strong title={email ?? undefined}>{email ?? "Local session"}</strong><span>Paper account</span></span>
            {email && (
              <button className="icon-btn ghost" onClick={() => signOut(clientAuth())} aria-label={`Sign out ${email}`} title="Sign out"><LogOut size={16} /></button>
            )}
          </div>
        </aside>
        <div className="main">
          <div className="topbar">
            <button className="menu-btn icon-btn ghost" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? "Close menu" : "Open menu"}>
              {open ? <X size={18} /> : <Menu size={18} />}
            </button>
            <SymbolSearch />
            <span className="spacer" />
            {status?.provider?.configured && (
              <span className={`pill hide-sm ${status.provider.market_open ? "live" : ""}`} title="EGX trades Sunday to Thursday, 10:00 to 14:30 Cairo time">
                <span className="dot" />{status.provider.market_open ? "Market open" : "Market closed"}
              </span>
            )}
            {d && (
              <span className={`pill hide-sm ${d.mode === "sample" || d.mode === "mixed" ? "warn" : ""}`}>
                {d.mode === "sample" ? "Sample data" : d.mode === "mixed" ? "Imported + sample data" : d.mode === "imported" ? "Imported data"
                  : d.mode === "younit" ? (d.is_live ? `Live · ${String(d.live_as_of).slice(11, 16)} Cairo` : `Close of ${d.latest_bar_date}`) : "No data"}
              </span>
            )}
            <span className="pill paper" title="Simulated orders only. Nothing is sent to a broker.">Paper trading</span>
            <button className="icon-btn ghost" onClick={toggle} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Theme">
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
          <MarketStrip />
          {error && <div className="banner danger" role="alert">{error}</div>}
          {d?.has_sample_data && (
            <div className="banner" role="status">
              <strong>Sample data.</strong> {d.mode === "mixed" ? "Some stocks still show" : "Prices shown are"} synthetic, generated for testing. They
              are not EGX market quotes. Import real history in Settings.
            </div>
          )}
          {status?.provider?.configured && <FeedUpdater provider={status.provider} />}
          <Background />
          {d && !d.has_sample_data && d.is_stale && (
            <div className="banner" role="status">
              <strong>Stale data.</strong> Latest bar is {d.latest_bar_date} ({d.trading_days_behind} sessions behind). These are not live prices.
            </div>
          )}
          <main className="content">{children}</main>
          <footer className="foot">
            <span>Paper trading only. Figures are for study, not investment advice.</span>
            <span>Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a> Lightweight Charts</span>
          </footer>
        </div>
      </div>
      </LiveProvider>
    </ThemeCtx.Provider>
  );
}
