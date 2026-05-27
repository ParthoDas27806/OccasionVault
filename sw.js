// ═══════════════════════════════════════════════
//  Birthday Reminder — Service Worker
//  Handles: offline caching, background sync,
//           push notifications, periodic sync
// ═══════════════════════════════════════════════

const CACHE_NAME = "birthday-reminder-v2";
const BASE = "/Birthday-Reminder";

const ASSETS_TO_CACHE = [
  BASE + "/",
  BASE + "/index.html",
  BASE + "/manifest.json",
];

// ── Install: cache core assets ──────────────────
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn("Some assets failed to cache:", err);
      });
    })
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ──────────────
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: serve from cache, fall back to network
self.addEventListener("fetch", event => {
  // Skip non-GET and cross-origin requests
  if (event.request.method !== "GET") return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful responses
        if (response && response.status === 200 && response.type === "basic") {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (event.request.mode === "navigate") {
          return caches.match(BASE + "/index.html");
        }
      });
    })
  );
});

// ── Push Notifications ──────────────────────────
self.addEventListener("push", event => {
  let data = { title: "Birthday Reminder", body: "You have an upcoming birthday!" };
  try {
    if (event.data) data = event.data.json();
  } catch(e) {
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "https://placehold.co/192x192/ff6b6b/ffffff?text=B",
      badge: "https://placehold.co/96x96/ff6b6b/ffffff?text=B",
      vibrate: [200, 100, 200],
      tag: "birthday-reminder",
      renotify: true,
      data: { url: BASE + "/" }
    })
  );
});

// ── Notification click: open the app ───────────
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(BASE) && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(BASE + "/");
      }
    })
  );
});

// ── Background Sync: retry failed saves ────────
self.addEventListener("sync", event => {
  if (event.tag === "sync-birthdays") {
    event.waitUntil(syncBirthdays());
  }
});

async function syncBirthdays() {
  console.log("Background sync: checking for pending birthday saves...");
  // The app uses Firebase which handles its own offline queue,
  // so this sync is a safety trigger to re-notify clients.
  const allClients = await clients.matchAll();
  allClients.forEach(client => {
    client.postMessage({ type: "SYNC_COMPLETE" });
  });
}

// ── Periodic Background Sync: daily reminder check
self.addEventListener("periodicsync", event => {
  if (event.tag === "daily-birthday-check") {
    event.waitUntil(checkBirthdaysAndNotify());
  }
});

async function checkBirthdaysAndNotify() {
  // Tell open clients to check and show any due notifications
  const allClients = await clients.matchAll();
  if (allClients.length > 0) {
    allClients.forEach(client => {
      client.postMessage({ type: "CHECK_BIRTHDAYS" });
    });
  }
}
