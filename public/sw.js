// Service worker for the offline card renderer and offline error pages.
//
// The precache list is generated at build time by
// `scripts/generate-sw-manifest.mjs` and served as `/sw-manifest.json`.
// During `install` we fetch that manifest and precache every listed asset
// under a versioned cache name. During `activate` we delete any cache that
// does not belong to the current version.

const CACHE_PREFIX = "lafiya-offline";
const MANIFEST_URL = "/sw-manifest.json";

// Diagnostic header value sent with navigation preload requests so the server
// can distinguish preloaded navigations from regular fetches. It carries no
// PHI or capability tokens.
const NAVIGATION_PRELOAD_HEADER = "lafiya-card";

// Card routes that benefit from navigation preload. Kept in sync with the
// offline card renderer routes.
const CARD_ROUTE_PREFIX = "/cards/";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch(MANIFEST_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Failed to load ${MANIFEST_URL}: ${response.status}`);
      }
      const manifest = await response.json();
      const cacheName = `${CACHE_PREFIX}-${manifest.version}`;
      const cache = await caches.open(cacheName);
      await cache.addAll(manifest.assets);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && !key.endsWith(currentVersion))
          .map((key) => caches.delete(key)),
      );
      // Enable navigation preload so the browser starts the network request
      // for card navigations in parallel with service-worker boot, removing
      // the worker startup latency from the critical path.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable(NAVIGATION_PRELOAD_HEADER);
      }
      await self.clients.claim();
    })(),
  );
});

// Resolve the active cache version from the manifest so `activate` can prune
// stale revisions without hardcoding a version string.
let currentVersion = null;
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SW_VERSION") {
    currentVersion = event.data.version;
  }
});

// Handle card navigations using the navigation preload response when the
// browser provides one, falling back to a regular fetch. Either path results
// in exactly one server hit, so capability consumption semantics are
// unchanged.
async function handleCardNavigation(event) {
  const { request } = event;
  const cache = await caches.open(`${CACHE_PREFIX}-${currentVersion ?? "latest"}`);

  // Prefer the preloaded response: the network request already started while
  // the worker was booting, so we avoid the startup latency entirely.
  if (event.preloadResponse) {
    try {
      const preloaded = await event.preloadResponse;
      if (preloaded) return preloaded;
    } catch (error) {
      // Fall through to a regular fetch below.
    }
  }

  try {
    return await fetch(request);
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = await cache.match("/offline.html");
    if (fallback) return fallback;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate" && url.pathname.startsWith(CARD_ROUTE_PREFIX)) {
    event.respondWith(handleCardNavigation(event));
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(`${CACHE_PREFIX}-${currentVersion ?? "latest"}`);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        return response;
      } catch (error) {
        const fallback = await cache.match("/offline.html");
        if (fallback) return fallback;
        throw error;
      }
    })(),
  );
});
