/// <reference lib="webworker" />

/**
 * VeriChain Service Worker
 * Enables full offline capability by caching the app shell and static assets.
 * AI models are stored separately in OPFS via RunAnywhere SDK.
 */

const CACHE_NAME = "verichain-v1";

const PRECACHE_URLS = [
  "/",
  "/manifest.json",
];

// Install — cache app shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch — network-first for navigation, cache-first for static assets
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and cross-origin requests (except CDN assets)
  if (request.method !== "GET") return;

  // In development, let all requests pass through to the dev server
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return;

  // Skip RunAnywhere model downloads — those use OPFS
  if (url.hostname === "huggingface.co") return;

  // Skip blockchain RPC calls — those need live data
  if (url.hostname.includes("polygon.technology")) return;
  if (url.hostname.includes("polygonscan.com")) return;

  // Navigation requests — network-first with cache fallback
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("/")))
    );
    return;
  }

  // Static assets (_next/static, fonts, images) — stale-while-revalidate
  if (
    url.pathname.startsWith("/_next/static") ||
    url.pathname.startsWith("/icon-") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".wasm") ||
    url.pathname.endsWith(".json")
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          const fetchPromise = fetch(request).then((response) => {
            cache.put(request, response.clone());
            return response;
          }).catch(() => cached || new Response("Offline", { status: 503 }));
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // Everything else — network-first with cache fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || new Response("Offline", { status: 503 })))
  );
});
