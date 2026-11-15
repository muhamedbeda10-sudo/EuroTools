"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from "firebase/auth";
import { clientAuth, firebaseConfigured } from "@/lib/client/firebase";
import { useApi } from "@/lib/useApi";

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
                Data: {d.mode === "sample" ? "sample (synthetic)" : d.mode === "mixed" ? "imported + sample" : d.mode === "imported" ? "imported CSV" : "none"}
                {d.latest_bar_date ? ` · as of ${d.latest_bar_date}` : ""}
              </span>
            )}
            <span className="badge">Broker: not connected</span>
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
          {d && !d.has_sample_data && d.is_stale && (
            <div className="banner" role="status">
              <strong>Stale data.</strong> Latest bar is {d.latest_bar_date} ({d.trading_days_behind} sessions behind). These are not live prices.
            </div>
          )}
          <main className="content">{children}</main>
        </div>
      </div>
    </ThemeCtx.Provider>
  );
}
