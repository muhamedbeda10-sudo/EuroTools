"use client";
import { useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { AWAKE_KEY, LOOK_MS, REAL_AUTO_AWAKE, REAL_AUTO_LOOK, SHOW_TOAST } from "@/lib/realAuto";
import { DATA_UPDATED } from "@/lib/useApi";

const SAME_NOTE_MS = 10 * 60 * 1000;   // the same remark is put on screen again only after this long
const CLOSED_MS = 5 * 60 * 1000;       // while the server says the market is closed, it is asked this often instead

const toast = (detail: { seq: string; title: string; message: string; note?: string; symbol?: string | null }) =>
  window.dispatchEvent(new CustomEvent(SHOW_TOAST, { detail }));

/** Automatic real orders run from here: while the owner's app is open during the session, it asks the server for a look twice a minute.
 *
 *  Mounted only when the server says automatic orders are on for this sign-in. The server decides everything at each
 *  look; this only asks, and shows what happened. It has its own timer so that no other background work can hold up a stop-loss.
 */
export default function RealAutoRunner({ marketOpen }: { marketOpen: boolean }) {
  // What the rest of the app believes about the session. The server's answer to a look is what counts; this is
  // only compared with it, so that an app left open since before the opening bell notices the bell.
  const believedOpen = useRef(marketOpen);
  believedOpen.current = marketOpen;
  useEffect(() => {
    let busy = false, stopped = false, notBefore = 0;
    const shown = new Map<string, number>();
    const look = async (now = false) => {
      if (busy || stopped || (!now && Date.now() < notBefore)) return;
      busy = true;
      try {
        // A window that is not in view does not fetch prices by itself: this look needs them fresh.
        if (document.visibilityState !== "visible") await api("/api/v1/data/live", { method: "POST" }).catch(() => null);
        const result = await api("/api/v1/real-orders/auto/tick", { method: "POST" });
        if (stopped) return;
        window.dispatchEvent(new CustomEvent(REAL_AUTO_LOOK, { detail: { at: Date.now(), result } }));
        notBefore = result.market_open === false ? Date.now() + CLOSED_MS : 0;
        if (result.ran && !believedOpen.current) window.dispatchEvent(new Event(DATA_UPDATED));   // the session began: prices start coming
        if (!result.ran) return;
        const moved: any[] = [...(result.exits ?? []), ...(result.sent ?? [])];
        for (const o of moved) {
          const what = `${o.side === "BUY" ? "Buy" : "Sell"} ${o.qty} ${o.symbol} at ${o.price}`;
          const message = o.status === "sent" ? `${what} was sent to the broker.` : o.status === "rejected" ? `${what} was refused by the broker.`
            : o.status === "failed" ? `${what} could not be sent.` : `${what}: no clear answer came back. Look at the Real account page.`;
          toast({ seq: `real-${o.id}`, title: o.origin === "automation" ? "Automatic sale" : "Automatic order", message, note: o.reason?.slice(0, 160), symbol: o.symbol });
          if (typeof Notification !== "undefined" && Notification.permission === "granted") new Notification("EGX Intelligence: real order", { body: message });
        }
        if (moved.length) window.dispatchEvent(new Event(DATA_UPDATED));
        for (const note of (result.notes ?? []) as string[]) {
          if (Date.now() - (shown.get(note) ?? 0) < SAME_NOTE_MS) continue;
          shown.set(note, Date.now());
          toast({ seq: `real-note-${shown.size}-${Date.now()}`, title: "Automatic orders", message: note });
        }
      } catch {
        // a look that did not get through is simply asked for again; the Real account page shows when the last one was
      } finally {
        busy = false;
      }
    };
    look(true);
    const timer = setInterval(() => look(), LOOK_MS);
    const onVisible = () => { if (document.visibilityState === "visible") look(true); };   // back on screen: look at once
    document.addEventListener("visibilitychange", onVisible);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  // Optionally keep the screen on, so a phone left open on its charger keeps watching. The browser drops the lock when
  // the page is hidden, so it is asked for again each time the page comes back.
  useEffect(() => {
    let lock: any = null, gone = false;
    const apply = async () => {
      let wanted = false;
      try { wanted = localStorage.getItem(AWAKE_KEY) === "1"; } catch {}
      if (wanted && marketOpen && !lock && document.visibilityState === "visible") {
        try {
          lock = await (navigator as any).wakeLock?.request("screen");
          lock?.addEventListener?.("release", () => { lock = null; });
          if (gone) { lock?.release?.(); lock = null; }
        } catch { lock = null; }
      } else if ((!wanted || !marketOpen) && lock) {
        lock.release?.();
        lock = null;
      }
    };
    apply();
    window.addEventListener(REAL_AUTO_AWAKE, apply);
    document.addEventListener("visibilitychange", apply);
    return () => {
      gone = true;
      window.removeEventListener(REAL_AUTO_AWAKE, apply);
      document.removeEventListener("visibilitychange", apply);
      lock?.release?.();
    };
  }, [marketOpen]);
  return null;
}
