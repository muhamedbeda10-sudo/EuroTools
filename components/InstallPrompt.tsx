"use client";

import { useEffect, useState } from "react";

/** Registers the service worker, and offers the install the browser is willing
 *  to give.
 *
 *  Chrome fires `beforeinstallprompt` and then waits: if nothing calls
 *  `prompt()` on that event, no install is ever offered. A bar appears here so
 *  somebody setting up a tablet can put the application on the home screen
 *  without knowing where the browser hides that menu.
 *
 *  iOS never fires the event — Safari's own Share ▸ Add to Home Screen is the
 *  only route — so nothing is shown there rather than a button that would do
 *  nothing.
 */
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED = "qc.install.dismissed";

export function InstallPrompt() {
  const [offer, setOffer] = useState<InstallEvent | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // After load, so registering never competes with the first render.
    const register = () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      try {
        if (localStorage.getItem(DISMISSED) === "1") return;
      } catch {
        // private mode — offer it, the worst case is one extra bar
      }
      setOffer(event as InstallEvent);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (!offer) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISSED, "1");
    } catch {
      // nothing to do; it will be offered again next time
    }
    setOffer(null);
  }

  return (
    <div className="no-print sticky bottom-0 z-30 border-t border-[var(--border)] bg-[var(--surface-2)] px-4 py-2.5">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <strong>Install QC on this device</strong>
          <span className="ms-2 text-[var(--muted)]">
            Opens full screen, straight from the home screen.
          </span>
        </p>

        <div className="flex items-center gap-2">
          <button type="button" className="btn min-h-11" onClick={dismiss}>
            Not now
          </button>
          <button
            type="button"
            className="btn btn-primary min-h-11"
            onClick={async () => {
              const event = offer;
              setOffer(null);
              await event.prompt();
              await event.userChoice;
            }}
          >
            Install
          </button>
        </div>
      </div>
    </div>
  );
}
