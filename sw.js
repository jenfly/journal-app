const CACHE_NAME = "journal-app-v11";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./logic.js",
  "./sync.js",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  // cache.addAll() would fetch() with default HTTP caching semantics, so a
  // still-fresh browser cache entry (GitHub Pages sends max-age=600) could
  // get baked into this new CACHE_NAME instead of the actual latest file —
  // {cache: "reload"} forces each request past the browser's HTTP cache.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map((url) =>
          fetch(url, { cache: "reload" }).then((res) => cache.put(url, res))
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        )
      )
  );
  self.clients.claim();
});

// Cache-first for the app shell, falling back to network for anything else.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // Supabase, Google Identity Services, and Drive requests must always go straight to the
  // network — they're never part of the cached app shell, and caching an API response (or an
  // auth redirect) here would be actively wrong, not just unnecessary.
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).catch(() => {
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
        })
      );
    })
  );
});
