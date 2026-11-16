/** Notifications on this device (Web Push): the browser's side. The server's side is backend/app/push.py. */
import { api } from "./api";

export type PushState = "unsupported" | "blocked" | "off" | "on";

const bytes = (key: string) => {
  const padded = (key + "=".repeat((4 - (key.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};
const text = (buffer: ArrayBuffer | null) => (buffer ? btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "");

export const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** On an iPhone or iPad, a web page can be sent notifications only once it is installed to the Home Screen. */
export const needsInstalling = () => typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent)
  && !(window.matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true);

async function worker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  const known = await navigator.serviceWorker.getRegistration();
  return known ?? navigator.serviceWorker.register("/sw.js");
}

/** Whether this device is subscribed with the application's present key. */
export async function pushState(publicKey: string | null): Promise<PushState> {
  if (!pushSupported() || !publicKey) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  const sub = await (await worker())?.pushManager.getSubscription();
  return sub && text(sub.options.applicationServerKey) === publicKey ? "on" : "off";
}

const label = () => {
  const ua = navigator.userAgent;
  return /iphone/i.test(ua) ? "iPhone" : /ipad/i.test(ua) ? "iPad" : /android/i.test(ua) ? "Android phone"
    : /windows/i.test(ua) ? "Windows computer" : /mac os/i.test(ua) ? "Mac" : "Browser";
};

/** Ask the person, subscribe this device, and tell the server. Throws with words for the person when it cannot. */
export async function enablePush(publicKey: string) {
  const reg = await worker();
  if (!reg) throw new Error("This browser cannot receive notifications from the app.");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this app in the browser's settings.");
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && text(sub.options.applicationServerKey) !== publicKey) { await sub.unsubscribe(); sub = null; }   // subscribed to an earlier key
  sub = sub ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(publicKey) });
  return api("/api/v1/push/subscribe", { method: "POST", json: { ...sub.toJSON(), label: label() } });
}

export async function disablePush() {
  const sub = await (await worker())?.pushManager.getSubscription();
  if (!sub) return null;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  return api("/api/v1/push/unsubscribe", { method: "POST", json: { endpoint } });
}
