// Service worker for the offline card renderer and offline error pages.
//
// The precache list is generated at build time by
// `scripts/generate-sw-manifest.mjs` and served as `/sw-manifest.json`.
// During `install` we fetch that manifest and precache every listed asset
// under a versioned cache name. During `activate` we delete any cache that
// does not belong to the current version.

const CACHE_PREFIX = "lafiya-offline";
const MANIFEST_URL = "/sw-manifest.json";

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

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

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
