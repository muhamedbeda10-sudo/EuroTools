"use client";
import { Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Chrome's offer to install, kept until the person asks for it. */
type InstallOffer = Event & { prompt: () => Promise<unknown> };
type Platform = "ios" | "android" | "desktop";

const STEPS: Record<Platform, { title: string; steps: string[] }> = {
  ios: { title: "On iPhone or iPad", steps: ["Open this page in Safari.", "Tap the Share button (the square with an arrow).", "Choose “Add to Home Screen”, then “Add”."] },
  android: { title: "On Android", steps: ["Open this page in Chrome.", "Open the browser menu (⋮).", "Choose “Install app” or “Add to Home screen”."] },
  desktop: { title: "On a computer", steps: ["Use Chrome or Edge.", "Click the install icon at the end of the address bar, or open the browser menu.", "Choose “Install EGX Intelligence”."] },
};

/** "Install app" in the menu. Where the browser offers to install, it opens that offer; where it
 *  does not (an iPhone has no such offer), it shows the three taps that do it. Not shown inside the installed app. */
export default function InstallApp() {
  const [installed, setInstalled] = useState(true);   // until the browser says otherwise, so nothing flashes in the installed app
  const [offer, setOffer] = useState<InstallOffer | null>(null);
  const [platform, setPlatform] = useState<Platform>("desktop");
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)");
    setInstalled(standalone.matches || (navigator as { standalone?: boolean }).standalone === true);
    const ua = navigator.userAgent;
    // an iPad calls itself a Mac; a Mac has no touch screen
    setPlatform(/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1) ? "ios" : /android/i.test(ua) ? "android" : "desktop");
    const onOffer = (e: Event) => setOffer(e as InstallOffer);   // not suppressed: the browser may still show its own banner
    const onInstalled = () => { setInstalled(true); setOffer(null); dialog.current?.close(); };
    const onMode = (e: MediaQueryListEvent) => setInstalled(e.matches);
    window.addEventListener("beforeinstallprompt", onOffer);
    window.addEventListener("appinstalled", onInstalled);
    standalone.addEventListener("change", onMode);
    return () => {
      window.removeEventListener("beforeinstallprompt", onOffer);
      window.removeEventListener("appinstalled", onInstalled);
      standalone.removeEventListener("change", onMode);
    };
  }, []);

  if (installed) return null;
  const install = async () => {
    if (offer) {
      setOffer(null);   // an offer can be used once
      try { await offer.prompt(); return; } catch { /* the browser withdrew it: show the steps instead */ }
    }
    dialog.current?.showModal();
  };
  const others = (Object.keys(STEPS) as Platform[]).filter((p) => p !== platform);
  return (
    <>
      <button type="button" className="nav-btn" onClick={install}><Download size={16} aria-hidden="true" />Install app</button>
      {createPortal(
        <dialog ref={dialog} className="sheet" aria-labelledby="install-title" onClick={(e) => { if (e.target === dialog.current) dialog.current?.close(); }}>
          <h2 id="install-title">Install EGX Intelligence</h2>
          <p className="muted">It opens from the home screen like any app, in its own window. Nothing is downloaded from a store, and it is always the latest version.</p>
          <h3>{STEPS[platform].title}</h3>
          <ol>{STEPS[platform].steps.map((s) => <li key={s}>{s}</li>)}</ol>
          <details>
            <summary>On another device</summary>
            {others.map((p) => (
              <div key={p}><h3>{STEPS[p].title}</h3><ol>{STEPS[p].steps.map((s) => <li key={s}>{s}</li>)}</ol></div>
            ))}
          </details>
          <p className="foot-note">The installed app signs in separately, once. It needs a connection: prices and balances are never shown from a saved copy.</p>
          <div className="form-actions"><button type="button" className="primary" onClick={() => dialog.current?.close()}>Done</button></div>
        </dialog>,
        document.body,
      )}
    </>
  );
}
