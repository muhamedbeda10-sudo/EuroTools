/* QC — the service worker that makes this installable.
 *
 *  Deliberately small. A quality system must not show an inspector a page
 *  built from yesterday's data and let them sign it, so nothing here caches an
 *  answer from Firestore: cross-origin requests are not touched at all, and
 *  they are how every read and write actually travels.
 *
 *  What it does cache is the application itself — the JavaScript and CSS under
 *  /_next/static/, whose filenames contain a hash of their contents. Those can
 *  be served from the cache without any staleness risk, because a new build
 *  asks for different filenames. That is what lets the installed app open in
 *  under a second on a tablet with poor wifi.
 *
 *  Pages are fetched from the network first, so a deployment is picked up on
 *  the next load rather than whenever a cache happens to expire. The cached
 *  copy is only reached for when the network fails, and then it is a shell
 *  that will say plainly that it could not load — which is the honest answer.
 */

const VERSION = "qc-v1";
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

self.addEventListener("install", (event) => {
  // The start URL, so an offline launch shows the application rather than the
  // browser's own error page.
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(["/"]))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)))
      )
      .then(() => self.clients.claim())
  );
});

/** Hashed build output: the name changes when the contents do, so a cached
 *  copy is never the wrong copy. */
const isImmutable = (url) => url.pathname.startsWith("/_next/static/");

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Firestore, Authentication, fonts — everything that is not this site is
  // left entirely alone. Caching a database response is how a signed record
  // ends up describing something that is no longer true.
  if (url.origin !== self.location.origin) return;

  if (isImmutable(url)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(ASSETS).then((cache) => cache.put(request, copy));
            }
            return response;
          })
      )
    );
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(SHELL).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) ?? (await caches.match("/")) ?? Response.error())
    );
  }
});
