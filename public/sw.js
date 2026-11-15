// EGX Intelligence service worker.
//
// It exists for one thing: when the phone has no connection, the installed app shows a page that
// says so instead of the browser's error. It keeps nothing on the device: no copy of the app, of its
// data, or even of that page, which is written out below. Prices, balances and every screen always
// come from the network, so nothing stale can be shown.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  // nothing is cached by this app; clear anything an earlier version left behind
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  // Only the loading of a page is looked at. Data requests, live streams and files are not touched.
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() => new Response(NO_CONNECTION, {
      status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    })),
  );
});

const NO_CONNECTION = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0e1626">
  <title>No connection · EGX Intelligence</title>
  <style>
    :root { color-scheme: light dark; --bg: #f3f5f8; --surface: #ffffff; --border: #e2e6ed; --text: #0c1424; --muted: #5a6575; --btn: #1d5fd3; }
    @media (prefers-color-scheme: dark) { :root { --bg: #0a0d12; --surface: #11151c; --border: #232a36; --text: #e8ecf2; --muted: #8d98aa; --btn: #2f6fe4; } }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text);
      font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
    main { width: min(420px, 100%); background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 28px 24px; text-align: center; }
    svg { width: 56px; height: 56px; }
    h1 { font-size: 19px; margin: 16px 0 6px; }
    p { margin: 0 0 20px; color: var(--muted); }
    button { font-family: inherit; font-size: 14px; font-weight: 600; height: 40px; padding: 0 18px; border: 0; border-radius: 8px; background: var(--btn); color: #fff; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--btn); outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <!-- drawn here, not loaded: there is no connection to load it over -->
    <svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="g" x1="0.12" y1="0" x2="0.88" y2="1"><stop offset="0" stop-color="#2f6fe4"/><stop offset="1" stop-color="#1b9e78"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><g transform="translate(13.4 13.4) scale(1.55)" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 3 8-9"/><path d="M15 5h5v5"/></g></svg>
    <h1>No connection</h1>
    <p>EGX Intelligence cannot reach the internet. Prices and balances are never shown from a saved copy, so there is nothing to show until the connection is back.</p>
    <button type="button" onclick="location.reload()">Try again</button>
  </main>
  <script>addEventListener("online", function () { location.reload(); });</script>
</body>
</html>
`;
