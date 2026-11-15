"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { clientAuth, firebaseConfigured } from "@/lib/client/firebase";
import { api } from "@/lib/api";
import { LiveProvider } from "@/lib/live";
import { DATA_UPDATED, useApi } from "@/lib/useApi";

const NAV = [
  ["/", "Dashboard"],
  ["/market", "Market & Categories"],
  ["/watchlist", "Watchlist"],
  ["/portfolio", "Portfolio"],
  ["/trades", "Trades & Transactions"],
  ["/simulator", "Strategy Simulator"],
  ["/strategies", "Strategy Management"],
  ["/settings", "Settings"],
] as const;

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
    <main style={{ maxWidth: 380, margin: "12vh auto", padding: "0 16px" }}>
      <form className="card" onSubmit={submit}>
        <h1>EGX Intelligence</h1>
        <p className="sub" style={{ marginBottom: 16 }}>Sign in with your account to continue.</p>
        <div className="field"><label htmlFor="si-email">Email</label>
          <input id="si-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="si-pass">Password</label>
          <input id="si-pass" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {error && <div className="note danger" role="alert">{error}</div>}
        <button className="primary" type="submit" disabled={busy} style={{ width: "100%" }}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>Paper trading only. Accounts are created by the administrator.</p>
      </form>
    </main>
  );
}

/** Nothing below this renders, and no request is made, until somebody is signed in. */
export default function Shell({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null | undefined>(firebaseConfigured ? undefined : null);
  useEffect(() => {
    if (!firebaseConfigured) return;
    return onAuthStateChanged(clientAuth(), setUser);
  }, []);
  if (firebaseConfigured && user === undefined) return <div className="empty" style={{ padding: 24 }}>Loading…</div>;
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
      <main style={{ maxWidth: 440, margin: "12vh auto", padding: "0 16px" }}>
        <div className="card">
          <h1>No access</h1>
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
            EGX Intelligence<small>Analysis &amp; paper trading</small>
          </div>
          <nav className="nav" aria-label="Main">
            {NAV.map(([href, label]) => (
              <Link key={href} href={href} aria-current={path === href || path === `${href}/` ? "page" : undefined}>
                {label}
              </Link>
            ))}
            <div className="soon">Later phases: Research &amp; News, Guidance &amp; Journal, Alerts, live-data paper trading</div>
          </nav>
        </aside>
        <div className="main">
          <div className="topbar">
            <button className="menu-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
              Menu
            </button>
            {d && (
              <span className={`badge ${d.mode === "sample" || d.mode === "mixed" ? "warn" : ""}`}>
                Data: {d.mode === "sample" ? "sample (synthetic)" : d.mode === "mixed" ? "imported + sample" : d.mode === "imported" ? "imported CSV" : d.mode === "younit" ? (d.is_live ? "Younit, live" : "Younit, daily") : "none"}
                {d.is_live ? ` · ${String(d.live_as_of).slice(11, 16)} Cairo` : d.latest_bar_date ? ` · as of ${d.latest_bar_date}` : ""}
              </span>
            )}
            <span className="badge">{status?.provider?.configured ? "Younit: market data only · orders off" : "Broker: not connected"}</span>
            <span className="badge paper">PAPER TRADING</span>
            <button onClick={toggle} aria-label="Toggle light or dark theme">
              {theme === "dark" ? "Light" : "Dark"} theme
            </button>
            {email && (
              <button onClick={() => signOut(clientAuth())} title={email} aria-label={`Sign out ${email}`}>Sign out</button>
            )}
          </div>
          {error && <div className="banner danger" role="alert">{error}</div>}
          {d?.has_sample_data && (
            <div className="banner" role="status">
              <strong>Sample data.</strong> {d.mode === "mixed" ? "Some stocks still show" : "Prices shown are"} synthetic, generated for testing. They
              are not EGX market quotes. Import real history in Settings.
            </div>
          )}
          {status?.provider?.configured && <FeedUpdater provider={status.provider} />}
          {d && !d.has_sample_data && d.is_stale && (
            <div className="banner" role="status">
              <strong>Stale data.</strong> Latest bar is {d.latest_bar_date} ({d.trading_days_behind} sessions behind). These are not live prices.
            </div>
          )}
          <main className="content">{children}</main>
        </div>
      </div>
      </LiveProvider>
    </ThemeCtx.Provider>
  );
}
