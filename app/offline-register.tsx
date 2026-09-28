"use client";

import { useEffect } from "react";

/**
 * Registers the offline service worker (public/sw.js) once the app has
 * loaded. It is registered for the whole origin so that by the time a
 * responder opens a /card/* page the worker is already active and able to
 * cache it.
 *
 * Registration is skipped in development to avoid caching the hot-reload dev
 * server's responses, which would make offline behaviour confusing to test.
 * Offline support is treated as a progressive enhancement: a registration
 * failure is swallowed and never breaks the page.
 *
 * Once the worker is active we also register a Periodic Background Sync task
 * (tag "lafiya-refresh", 12h minimum interval) so cached emergency envelopes
 * can be refreshed while the device is online without the user reopening the
 * card. Periodic sync is only available on installed Chromium PWAs, so it is
 * registered best-effort and silently skipped where unsupported.
 */

const PERIODIC_SYNC_TAG = "lafiya-refresh";
const PERIODIC_SYNC_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

async function registerPeriodicSync(registration: ServiceWorkerRegistration) {
  // Periodic Background Sync is a progressive enhancement: only Chromium
  // installed PWAs expose it, and it requires the user to have granted the
  // periodic-background-sync permission. Never let a failure surface.
  const periodicSync = (
    registration as ServiceWorkerRegistration & {
      periodicSync?: {
        register: (tag: string, options: { minInterval: number }) => Promise<void>;
      };
    }
  ).periodicSync;

  if (!periodicSync || typeof periodicSync.register !== "function") return;

  try {
    await periodicSync.register(PERIODIC_SYNC_TAG, {
      minInterval: PERIODIC_SYNC_MIN_INTERVAL_MS,
    });
  } catch {
    // Permission denied or unsupported: refresh stays user-driven.
  }
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    if (process.env.NODE_ENV === "development") return;

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { type: "module" })
        .then((registration) => {
          // Only schedule periodic refresh once the worker is active so the
          // sync event has a handler to receive it.
          if (registration.active) {
            void registerPeriodicSync(registration);
            return;
          }

          const worker = registration.installing ?? registration.waiting;
          if (!worker) return;

          worker.addEventListener("statechange", () => {
            if (worker.state === "activated") {
              void registerPeriodicSync(registration);
            }
          });
        })
        .catch(() => {
          // Offline caching is best-effort; ignore registration errors.
        });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register);
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
