"use client";
import { BellRing, CircleCheck, CircleDashed, Copy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { clientAuth, firebaseConfigured } from "@/lib/client/firebase";
import { disablePush, enablePush, needsInstalling, pushState, type PushState } from "@/lib/push";
import { DATA_UPDATED, useApi } from "@/lib/useApi";
import { CardHead, State } from "@/components/ui";

const when = (stamp?: string | null) => (stamp ? new Date(stamp).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Africa/Cairo" }) : "never");

const KEY_STATE: Record<string, string> = {
  none: "There is no background key on the server yet.",
  unreadable: "The key on the server cannot be read by this server. Create a new one.",
  other: "The key on the server belongs to another sign-in.",
  replaced: "The key on the server is an older one. Put the latest key there, or create a new one.",
  ok: "Your background key is on the server.",
};

function Step({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className={done ? "ok" : "warn"}>
      {done ? <CircleCheck size={16} aria-label="Done" /> : <CircleDashed size={16} aria-label="Not done yet" />}
      <div><strong>{title}</strong><span>{children}</span></div>
    </li>
  );
}

/** Running without the app open, and notifications: the owner lends the server their sign-in, switches it on, and chooses which devices are told. */
export default function RealBackground() {
  const { data, loading, error, status, reload } = useApi("/api/v1/background");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [device, setDevice] = useState<PushState>("unsupported");
  const publicKey: string | null = data?.push?.public_key ?? null;
  const look = useCallback(() => { pushState(publicKey).then(setDevice).catch(() => setDevice("unsupported")); }, [publicKey]);
  useEffect(look, [look]);

  if (status === 403 || status === 404) return null;   // the card above already says whose this is

  const run = async (work: () => Promise<any>, done?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const out = await work();
      if (done) setMsg({ ok: true, text: done });
      reload();
      look();
      window.dispatchEvent(new Event(DATA_UPDATED));
      return out;
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const createKey = () => run(async () => {
    if (data.server_key === "ok" && !confirm("Create a new background key?\n\nThe key now on the server stops working at once, and background running is switched off until the new key is there.")) return;
    const token = firebaseConfigured ? clientAuth().currentUser?.refreshToken : undefined;
    if (!token) throw new Error("Background running is for the deployed app, where there is a sign-in to lend.");
    const out = await api("/api/v1/background/key", { method: "POST", json: { refresh_token: token } });
    setMade(out.key);
    setCopied(false);
  });
  const copy = async () => {
    if (!made) return;
    try { await navigator.clipboard.writeText(made); setCopied(true); } catch { setMsg({ ok: false, text: "Could not copy. Select the text and copy it by hand." }); }
  };
  const turn = (enabled: boolean) => {
    if (enabled && !confirm("Switch background running on?\n\nThe server will then take the automation's looks every minute during the session, signed in as you, also when the app is closed: " +
      "it sends what fits your automatic box and sells at stop-losses without anyone watching.")) return;
    return run(() => api("/api/v1/background", { method: "PUT", json: { enabled } }),
      enabled ? "Background running is on. The first look comes within a minute or two during the session." : "Background running is off: the server does nothing by itself.");
  };
  const ready = data && data.timer_ready && data.server_key === "ok";
  return (
    <div className="card">
      <CardHead title="Running without the app open">
        {data && <span className={`badge ${data.enabled ? "bad" : ""}`}>{data.enabled ? "background running on" : "off"}</span>}
      </CardHead>
      <State loading={loading} error={error}>
        {data && (
          <>
            <p className="muted" style={{ marginTop: 0, maxWidth: "95ch" }}>
              With this on, the server takes the automation&apos;s looks <strong>by itself, every minute during the session</strong>: it reads the prices, sends
              what fits your automatic box, sells at stop-losses and take-profits, and runs the assistant&apos;s review at the schedule you chose in
              Settings → Assistant. The app does not need to be open, and the phone can be locked. Everything it may do is still decided by your box and limits above.
            </p>
            {!data.available && <div className="note">Not available: the server has no secret to seal a key with.</div>}
            <ul className="checks">
              <Step done={data.timer_ready} title="The server's timer">
                {data.timer_ready ? "The hosting platform wakes the server every minute, Sunday to Thursday, around the session." : "Not set up on the server yet (CRON_SECRET)."}
              </Step>
              <Step done={data.server_key === "ok"} title="Your background key on the server">
                {KEY_STATE[data.server_key] ?? data.server_key}{data.key_made_at ? ` Latest key created ${when(data.key_made_at)} Cairo.` : ""}
              </Step>
              <Step done={data.enabled} title="Switched on by you">
                {data.enabled ? `Last background look: ${when(data.beat?.at)} Cairo${data.beat && !data.beat.ran && data.beat.why ? ` · ${String(data.beat.why).replace(/\.$/, "")}` : ""}.`
                  : "Off: the server does nothing by itself."}
              </Step>
            </ul>
            {data.silent && (
              <div className="note danger" role="alert"><strong>The server has not looked for several minutes</strong> although the session is running and this is switched on.
                Nothing is being sent or watched in the background right now. Keep the app open, and check the key and the timer.</div>
            )}
            {data.beat?.data_problem && data.enabled && <div className="note">At the last background look the prices could not be read: {data.beat.data_problem}</div>}

            <h3 style={{ marginTop: 18 }}>The background key</h3>
            <p className="muted" style={{ maxWidth: "95ch", fontSize: 13 }}>
              The server has no sign-in of its own. A background key lends it yours: it is your sign-in, sealed so that only this server can open it. It is
              shown once, and you place it in the server&apos;s settings yourself. Changing your password, or creating a new key, retires it.
            </p>
            {made ? (
              <div className="key-box">
                <label htmlFor="bg-key">Your background key (shown once)</label>
                <textarea id="bg-key" readOnly rows={4} value={made} onFocus={(e) => e.target.select()} dir="ltr" spellCheck={false} />
                <div className="form-actions"><button type="button" className="primary" onClick={copy}><Copy size={14} aria-hidden="true" /> {copied ? "Copied" : "Copy the key"}</button></div>
                <ol className="muted" style={{ fontSize: 13, paddingLeft: 18, margin: "10px 0 0" }}>
                  <li>Open the project on Vercel → <strong>Settings</strong> → <strong>Environment Variables</strong>.</li>
                  <li>Add a variable named <code>BACKGROUND_KEY</code>, paste the key as its value, choose <strong>Production</strong> and mark it <strong>Sensitive</strong>. Save.</li>
                  <li>Redeploy the project (Deployments → the latest one → Redeploy), then come back here and switch background running on.</li>
                </ol>
              </div>
            ) : (
              <div className="form-actions">
                <button type="button" disabled={busy || !data.available} onClick={createKey}>{data.server_key === "ok" ? "Create a new background key" : "Create a background key"}</button>
              </div>
            )}

            <div className="form-actions" style={{ marginTop: 16 }}>
              {data.enabled
                ? <button type="button" className="danger" disabled={busy} onClick={() => turn(false)}>Switch background running off</button>
                : <button type="button" className="primary" disabled={busy || !ready} title={ready ? undefined : "The timer and your key must be on the server first"} onClick={() => turn(true)}>Switch background running on</button>}
            </div>

            <h3 style={{ marginTop: 22 }}><BellRing size={15} aria-hidden="true" style={{ verticalAlign: "-2px" }} /> Notifications on this device</h3>
            <p className="muted" style={{ maxWidth: "95ch", fontSize: 13 }}>
              When the automation sends an order, sells at a stop-loss, or needs you, the devices you switch on here are told at once, also when the app is closed.
              A notice names the order and what became of it, never a balance.
            </p>
            {device === "unsupported" && <div className="note">{needsInstalling() ? "On an iPhone or iPad, install the app to the Home Screen first (menu → Install app), then open it from there and switch notifications on."
              : !data.push?.available ? "Notifications are not available on this server." : "This browser cannot receive notifications from the app."}</div>}
            {device === "blocked" && <div className="note">Notifications are blocked for this app in the browser&apos;s settings. Allow them there, then come back.</div>}
            <div className="form-actions">
              {device === "off" && <button type="button" className="primary" disabled={busy} onClick={() => run(() => enablePush(publicKey!), "This device will be told.")}>Turn on notifications on this device</button>}
              {device === "on" && <>
                <button type="button" disabled={busy} onClick={() => run(() => api("/api/v1/push/test", { method: "POST" }), "A test notification was sent to your devices.")}>Send a test</button>
                <button type="button" className="danger" disabled={busy} onClick={() => run(() => disablePush(), "This device is no longer told.")}>Turn off on this device</button>
              </>}
            </div>
            <p className="muted" style={{ fontSize: 12.5, margin: "8px 0 0" }}>
              {data.push?.devices?.length ? `Devices that are told: ${data.push.devices.map((d: any) => d.label).join(", ")}.` : "No device is told yet."}
            </p>

            <ul className="muted" style={{ fontSize: 12.5, maxWidth: "100ch", paddingLeft: 18, margin: "14px 0 0" }}>
              <li>The server looks once a minute; the open app looks twice a minute. With both, whichever looks first acts, and an order is still sent once.</li>
              <li>It works during the session only, and it cannot tell you that it has stopped: this card and the Real account page show when the last background look was.</li>
              <li>Stop-losses are still the app&apos;s, not the broker&apos;s, and shares that have not settled still cannot be sold.</li>
              <li>The assistant&apos;s review also runs in the background, and costs what a review costs, inside the daily ceiling in Settings → Assistant.</li>
            </ul>
            {msg && <div className={`note ${msg.ok ? "info" : "danger"}`} role={msg.ok ? "status" : "alert"} style={{ marginTop: 12 }}>{msg.text}</div>}
          </>
        )}
      </State>
    </div>
  );
}
