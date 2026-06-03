// OccasionVault Service Worker v5
const CACHE = "occasionvault-v6";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== "occasionvault-data").map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Never cache HTML — always fresh
self.addEventListener("fetch", e => {
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("./index.html")));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res && res.status === 200 && res.type === "basic") {
        caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      }
      return res;
    }))
  );
});

// Show notifications sent from app
self.addEventListener("push", e => {
  let d = { title: "OccasionVault", body: "You have an upcoming occasion!" };
  try { if (e.data) d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: "./icon.svg", badge: "./icon.svg",
    vibrate: [200, 100, 200], tag: d.tag || "ov-notif", renotify: true,
  }));
});

// Handle notification click
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes("OccasionVault") || c.url.includes("Birthday-Reminder") || c.url.includes("github.io")) {
          return c.focus();
        }
      }
      return clients.openWindow("./");
    })
  );
});

// Listen for messages from the app to show notifications
self.addEventListener("message", e => {
  if (e.data && e.data.type === "SHOW_NOTIFICATION") {
    self.registration.showNotification(e.data.title, {
      body: e.data.body,
      icon: "./icon.svg",
      badge: "./icon.svg",
      vibrate: [200, 100, 200],
      tag: e.data.tag || "ov-msg",
      renotify: true,
    });
  }
});

// ═══════════════════════════════════════════════
//  PERIODIC BACKGROUND SYNC REMINDERS
// ═══════════════════════════════════════════════
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const CAT_LABELS = {
  birthday: "Birthday",
  anniversary: "Anniversary",
  event: "Event",
  work: "Work",
  health: "Health",
  travel: "Travel",
  finance: "Finance",
  festival: "Festival",
  other: "Other"
};
function catLabel(cat) { return CAT_LABELS[cat] || cat; }

function formatTime(t) {
  if (!t) return "9:00 AM";
  const [h,m] = t.split(":").map(Number);
  return `${h%12||12}:${String(m).padStart(2,"0")} ${h>=12?"PM":"AM"}`;
}

function getDaysUntil(month, day, recurring, fullDate, recurrenceMode) {
  const today = new Date(); today.setHours(0,0,0,0);
  if (!recurring && fullDate) {
    const d = new Date(fullDate); d.setHours(0,0,0,0);
    const diff = Math.ceil((d - today) / 86400000);
    return diff < 0 ? null : diff;
  }
  if (recurrenceMode === "monthly") {
    let next = new Date(today.getFullYear(), today.getMonth(), day);
    if (next < today) next = new Date(today.getFullYear(), today.getMonth()+1, day);
    return Math.ceil((next - today) / 86400000);
  }
  let next = new Date(today.getFullYear(), month-1, day);
  if (next < today) next = new Date(today.getFullYear()+1, month-1, day);
  return Math.ceil((next - today) / 86400000);
}

async function getOccasionsFromCache() {
  try {
    const cache = await caches.open("occasionvault-data");
    const response = await cache.match("/occasions.json");
    if (response) {
      return await response.json();
    }
  } catch (e) {
    console.warn("SW: Failed to get occasions from cache:", e);
  }
  return [];
}

async function wasNotificationFiredToday(tag) {
  try {
    const cache = await caches.open("occasionvault-data");
    const response = await cache.match("/fired-notifications.json");
    const todayStr = new Date().toDateString();
    if (response) {
      const fired = await response.json();
      if (fired[tag] === todayStr) {
        return true;
      }
    }
  } catch (e) {
    console.warn("SW: Failed to check fired notifications cache:", e);
  }
  return false;
}

async function markNotificationFiredToday(tag) {
  try {
    const cache = await caches.open("occasionvault-data");
    const response = await cache.match("/fired-notifications.json");
    const todayStr = new Date().toDateString();
    let fired = {};
    if (response) {
      try { fired = await response.json(); } catch(e){}
    }
    fired[tag] = todayStr;
    
    // Clean up old dates
    for (const key in fired) {
      if (fired[key] !== todayStr) {
        delete fired[key];
      }
    }
    
    await cache.put("/fired-notifications.json", new Response(JSON.stringify(fired), {
      headers: { "Content-Type": "application/json" }
    }));
  } catch (e) {
    console.warn("SW: Failed to mark notification as fired in cache:", e);
  }
}

async function checkBackgroundOccasions() {
  const occasions = await getOccasionsFromCache();
  if (!occasions || occasions.length === 0) return;

  const today = new Date();
  const currentHour = today.getHours();
  const currentMin = today.getMinutes();

  for (const o of occasions) {
    const remindTime = o.remindTime || "09:00";
    const [rh, rm] = remindTime.split(":").map(Number);
    
    // Trigger if it's past or equal to the remind time
    if (currentHour < rh || (currentHour === rh && currentMin < rm)) {
      continue;
    }

    const days = getDaysUntil(o.month, o.day, o.recurring, o.fullDate, o.recurrenceMode);
    if (days === null) continue;
    
    const remindDays = parseInt(o.remind || 7);
    
    if (days === 0) {
      const tag = `ov-today-${o.id}`;
      const fired = await wasNotificationFiredToday(tag);
      if (!fired) {
        await self.registration.showNotification(`${o.emoji} Today: ${o.name}! 🎉`, {
          body: o.note || `${catLabel(o.cat)} — Don't forget!`,
          icon: "./icon.svg",
          badge: "./icon.svg",
          vibrate: [200, 100, 200],
          tag: tag,
          renotify: true
        });
        await markNotificationFiredToday(tag);
      }
    } else if (days === remindDays) {
      const tag = `ov-remind-${o.id}`;
      const fired = await wasNotificationFiredToday(tag);
      if (!fired) {
        await self.registration.showNotification(`${o.emoji} ${o.name} in ${days} day${days===1?"":"s"}!`, {
          body: `${catLabel(o.cat)} · ${MONTHS_SHORT[o.month-1]} ${o.day} · Set for ${formatTime(o.remindTime)}`,
          icon: "./icon.svg",
          badge: "./icon.svg",
          vibrate: [200, 100, 200],
          tag: tag,
          renotify: true
        });
        await markNotificationFiredToday(tag);
      }
    }
  }
}

// Listen for periodic background sync
self.addEventListener("periodicsync", event => {
  if (event.tag === "check-occasions") {
    event.waitUntil(checkBackgroundOccasions());
  }
});
