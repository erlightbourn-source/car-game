/*
 * sw.js — Lane Rush service worker (PWA: installable + offline).
 *
 * Strategy:
 *  - Navigations (the HTML) are NETWORK-FIRST so a freshly deployed version is
 *    picked up when online; falls back to the cached shell when offline.
 *  - Versioned static assets (?v=N JS/CSS/images) are CACHE-FIRST — they're
 *    immutable per version, so once cached they load instantly and offline.
 *  - The cache name is bumped with each release; old caches are purged on
 *    activate. Same-origin only (matches the site's strict CSP).
 */
const CACHE = "lane-rush-v31";
const CORE = ["./", "./index.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  // Network-first for page navigations so new deploys are seen when online.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
    );
    return;
  }

  // Cache-first for everything else (versioned assets are immutable per release).
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.status === 200 && new URL(req.url).origin === self.location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }))
  );
});
