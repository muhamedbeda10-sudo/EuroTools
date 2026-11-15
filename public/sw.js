// EGX Intelligence service worker.
//
// It exists for one thing: when the phone has no connection, the installed app shows a page that
// says so instead of the browser's error. It never keeps a copy of the app or of its data: prices,
// balances and every screen always come from the network, so nothing stale can be shown.
const OFFLINE_PAGE = "/offline.html";
const CACHE = "egx-offline-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add(new Request(OFFLINE_PAGE, { cache: "reload" }))).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  // Only the loading of a page is looked at. Data requests, live streams and files are not touched.
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_PAGE).then((page) => page || Response.error())));
});
