/* Retirement notice for the service worker of the app that used to live at
 * this address. Browsers that installed it still ask for /sw.js; this version
 * deletes its caches, unregisters itself and reloads the open pages, so nobody
 * is left looking at a cached copy of the old application. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) await caches.delete(key);
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url);
    })(),
  );
});
