// Lafiya emergency-card offline protocol (envelope v1).
//
// We intentionally cache a structured, versioned projection rather than the
// rendered HTML. Offline presentation therefore cannot accidentally inherit a
// live-looking verification badge, stale scripts, or an old route layout.

import {
  CARD_CACHE_LIMITS,
  createOfflineEnvelope,
  enforceCacheBudget,
  offlineEnvelopeResponse,
  renderOfflineEnvelope,
  validateOfflineEnvelope,
  withEntryMetaHeaders,
} from "./offline-cache-helpers.js";

const CARD_CACHE = "lafiya-emergency-envelopes-v1";
const CARD_PATH_PREFIX = "/card/";
const PERIODIC_SYNC_TAG = "lafiya-refresh";
const PERIODIC_SYNC_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

// Web Push (RFC 8291) payloads are decrypted by the browser before they reach
// this handler. Payloads must never contain PHI or capability tokens: only a
// generic title/body plus a same-origin path to open on click.
const PUSH_DEFAULT_TITLE = "Lafiya";
const PUSH_DEFAULT_BODY = "You have a new notification.";
const PUSH_DEFAULT_PATH = "/";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Remove legacy rendered-card caches: they bypass envelope expiry and
      // cannot state the three freshness dimensions honestly.
      await Promise.all(
        keys
          .filter((key) => key !== CARD_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const url = new URL(request.url);
  if (
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(CARD_PATH_PREFIX)
  )
    return;
  event.respondWith(handleCardNavigation(event));
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag !== PERIODIC_SYNC_TAG) return;
  event.waitUntil(refreshCachedEnvelopes());
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event));
});

async function withCacheLock(name, fn) {
  const locks = self.navigator && self.navigator.locks;
  if (locks && typeof locks.request === "function") {
    return locks.request(`lafiya-cache:${name}`, fn);
  }
  return fn();
}

async function storeEnvelope(request, envelope) {
  const response = offlineEnvelopeResponse(envelope);
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  return withCacheLock(CARD_CACHE, async () => {
    const cache = await caches.open(CARD_CACHE);
    const { admit } = await enforceCacheBudget({
      cache,
      incomingRequest: request,
      incomingSize: bytes.byteLength,
      maxEntries: CARD_CACHE_LIMITS.maxEntries,
      maxBytes: CARD_CACHE_LIMITS.maxBytes,
    });
    if (!admit) return false;
    const headers = withEntryMetaHeaders(response.headers, {
      cachedAt: envelope.cachedAt,
      lastAccessed: Date.now(),
      size: bytes.byteLength,
    });
    await cache.put(request, new Response(bytes, { headers }));
    return true;
  });
}

// A capability token with a view budget must never be refreshed: a refresh
// would consume a view. Only refresh envelopes that carry no view budget.
async function isRefreshableEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") return false;
  const capability = envelope.capability;
  if (!capability || typeof capability !== "object") return true;
  const budget = capability.viewBudget ?? capability.viewsRemaining;
  return budget === undefined || budget === null;
}

async function refreshCachedEnvelopes() {
  const cache = await caches.open(CARD_CACHE);
  const requests = await cache.keys();
  await Promise.all(
    requests.map(async (request) => {
      const url = new URL(request.url);
      if (
        url.origin !== self.location.origin ||
        !url.pathname.startsWith(CARD_PATH_PREFIX)
      )
        return;

      const cached = await cache.match(request);
      const envelope = cached ? await cached.json().catch(() => null) : null;
      if (!(await isRefreshableEnvelope(envelope))) return;

      try {
        const networkResponse = await fetch(request);
        if (networkResponse.status === 404) {
          // Revoked or removed card: evict the stale local copy.
          await cache.delete(request);
          return;
        }
        if (!networkResponse.ok) return;

        const refreshed = await createOfflineEnvelope(
          await networkResponse.clone().text(),
          new Date().toISOString(),
        );
        if (refreshed) {
          await storeEnvelope(request, refreshed);
        } else {
          // Consent withdrawal, malformed source, or unsupported version:
          // treat as revocation and evict.
          await cache.delete(request);
        }
      } catch {
        // Offline or transient failure: keep the existing envelope.
      }
    }),
  );
}

// Only same-origin, non-card paths are opened from a notification. Card paths
// carry capability tokens in the URL, so they are never used as a push target.
function safeNotificationPath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return PUSH_DEFAULT_PATH;
  }
  try {
    const url = new URL(rawPath, self.location.origin);
    if (url.origin !== self.location.origin) return PUSH_DEFAULT_PATH;
    if (url.pathname.startsWith(CARD_PATH_PREFIX)) return PUSH_DEFAULT_PATH;
    return url.pathname + url.search;
  } catch {
    return PUSH_DEFAULT_PATH;
  }
}

function parsePushPayload(event) {
  if (!event.data) return {};
  try {
    const parsed = event.data.json();
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

async function handlePush(event) {
  const payload = parsePushPayload(event);
  const title =
    typeof payload.title === "string" && payload.title.length > 0
      ? payload.title
      : PUSH_DEFAULT_TITLE;
  const body =
    typeof payload.body === "string" && payload.body.length > 0
      ? payload.body
      : PUSH_DEFAULT_BODY;
  const path = safeNotificationPath(payload.path);

  await self.registration.showNotification(title, {
    body,
    tag: typeof payload.tag === "string" ? payload.tag : undefined,
    data: { path },
  });
}

async function handleNotificationClick(event) {
  const path = safeNotificationPath(
    event.notification && event.notification.data
      ? event.notification.data.path
      : undefined,
  );
  const targetUrl = new URL(path, self.location.origin).href;

  const clientList = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of clientList) {
    if (client.url === targetUrl && "focus" in client) {
      return client.focus();
    }
  }
  if (self.clients.openWindow) {
    return self.clients.openWindow(targetUrl);
  }
}

async function handleCardNavigation(event) {
  const request = event.request;
  try {
    const networkResponse = await fetch(request);
    if (!networkResponse.ok) return networkResponse;

    const envelope = await createOfflineEnvelope(
      await networkResponse.clone().text(),
      new Date().toISOString(),
    );
    const cache = await caches.open(CARD_CACHE);
    if (envelope) {
      await storeEnvelope(request, envelope);
    } else {
      // Consent withdrawal, malformed source, unsupported envelope version,
      // and unavailable cards remove any prior local copy at next contact.
      await cache.delete(request);
    }
    return networkResponse;
  } catch {
    const cache = await caches.open(CARD_CACHE);
    const cached = await cache.match(request);
    const envelope = cached ? await cached.json().catch(() => null) : null;
    const validation = await validateOfflineEnvelope(
      envelope,
      new Date().toISOString(),
    );
    if (!validation.valid) {
      if (cached) event.waitUntil(cache.delete(request));
      return new Response(renderOfflineEnvelope(null, validation.reason), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response(renderOfflineEnvelope(envelope), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}
