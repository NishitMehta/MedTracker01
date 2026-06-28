/* Taper service worker — offline app shell.
   Code files (html/js/css/json) are network-first AND fetched with the HTTP cache
   bypassed (cache:'no-store'), so a deploy is picked up immediately. Icons are
   cache-first. Google auth/API traffic is never intercepted.
   The page registers this with { updateViaCache:'none' } so the worker script
   itself is never served from the HTTP cache. */
const CACHE = "taper-v3";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) =>
        fetch(new Request(u, { cache: "no-store" })).then((r) => r.ok && c.put(u, r)).catch(() => {})
      )))
      .then(() => self.skipWaiting())
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
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  const isCode = req.mode === "navigate" || /\.(?:js|css|html|json)$/.test(url.pathname);

  if (isCode) {
    // network-first, bypassing the browser HTTP cache, fall back to cache offline
    e.respondWith(
      fetch(req, { cache: "no-store" }).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req.mode === "navigate" ? "./index.html" : req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((c) => c || caches.match("./index.html")))
    );
    return;
  }

  // cache-first for icons/images
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => cached))
  );
});

// Tapping a notification focuses or opens the app.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow("./");
    })
  );
});
