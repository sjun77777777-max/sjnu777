const CACHE_NAME = "school-shop-cache-v41";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./boot.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./assets/logo.png",
  "./assets/mascot-name.png",
  "./assets/loading-mascot.png",
  "./assets/toast-mascot.png",
];

function isAppShell(url) {
  const path = url.pathname || "";
  return (
    path.endsWith("/") ||
    /\/(index\.html|app\.js|boot\.js|styles\.css|sw\.js|manifest\.webmanifest)$/.test(path)
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))),
    ])
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try {
    url = new URL(req.url);
  } catch (_) {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (isAppShell(url)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match(req).then((cached) => cached || new Response("오프라인 상태입니다.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }))
        )
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => cached || new Response("오프라인 상태입니다.", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
    })
  );
});
