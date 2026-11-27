/* Diamondz Tokenize — service worker (installable app). Adapted from BRX Water's, same conservative rules:
 *   - page loads (navigations)  -> NETWORK FIRST; the cached shell is only a fallback when offline
 *   - /assets/* (content-hashed) -> cache-first: a new build has new file names, so this can't go stale
 *   - /icons, /logos, favicon    -> stale-while-revalidate
 *   - /api/* and anything cross-origin (RPCs, thirdweb, Sumsub, Mastercard) -> NEVER cached
 * Bump CACHE_VERSION if a bad shell ever ships: activate() deletes every other cache. */
const CACHE_VERSION = "dt-v1";
const SHELL = `${CACHE_VERSION}-shell`, ASSETS = `${CACHE_VERSION}-assets`, MEDIA = `${CACHE_VERSION}-media`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.all(["/", "/icons/icon-192.png", "/favicon.svg"].map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return; // straight to network

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => { if (res.ok) caches.open(SHELL).then((c) => c.put("/", res.clone())); return res; })
        .catch(() => caches.match("/").then((r) => r ?? new Response("You're offline. Reconnect to use Diamondz Tokenize.", { status: 503, headers: { "content-type": "text/plain" } }))),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(ASSETS).then((c) => c.match(req).then((hit) => hit ?? fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }))),
    );
    return;
  }
  if (/^\/(icons|logos)\//.test(url.pathname) || url.pathname === "/favicon.svg") {
    event.respondWith(
      caches.open(MEDIA).then((c) => c.match(req).then((hit) => {
        const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
        return hit ?? net;
      })),
    );
  }
});
