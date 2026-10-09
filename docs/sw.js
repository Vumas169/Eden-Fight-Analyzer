// Network first for the app files, cache as fallback when offline.
// Database requests and the version check are never cached here.
// V must match the ?v= numbers in index.html (raise both together).
const V = "24";
const CACHE = `efa-v${V}`;
const SHELL = ["./", "index.html", `app.css?v=${V}`, `app.js?v=${V}`, "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png"];

const SHELL_URLS = new Set(SHELL.map(p => new URL(p, self.registration.scope).href));

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.searchParams.has("check")) return;
  event.respondWith(
    fetch(req).then(res => {
      // only the app files are kept, one copy each
      if (res.ok && SHELL_URLS.has(url.href)) {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window" }).then(list => (list[0] ? list[0].focus() : self.clients.openWindow("./"))));
});
