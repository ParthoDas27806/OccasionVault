// OccasionVault Service Worker v7 — handles both caching AND FCM push
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// Firebase config
firebase.initializeApp({
  apiKey:            "AIzaSyDVVBPl9EMTZGUYsMRzigvKcDVQkQBq2-U",
  authDomain:        "birthday-reminder-630a2.firebaseapp.com",
  projectId:         "birthday-reminder-630a2",
  storageBucket:     "birthday-reminder-630a2.firebasestorage.app",
  messagingSenderId: "20710694139",
  appId:             "1:20710694139:web:8125398222c068c6fe245e"
});

// Handle background FCM messages (when app is closed)
const messaging = firebase.messaging();
messaging.onBackgroundMessage(payload => {
  const title = payload.notification?.title || 'OccasionVault';
  const body  = payload.notification?.body  || 'You have an upcoming occasion!';
  self.registration.showNotification(title, {
    body,
    icon:    '/OccasionVault/icons/icon-192x192.png',
    badge:   '/OccasionVault/icons/icon-96x96.png',
    vibrate: [200, 100, 200],
    tag:     payload.data?.tag || 'ov-push',
    renotify: true,
    data:    { url: payload.data?.url || '/OccasionVault/' }
  });
});

// Cache config
const CACHE = 'occasionvault-v7';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — never cache HTML, cache everything else
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/OccasionVault/index.html')));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      }
      return res;
    }))
  );
});

// Notification click — open app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/OccasionVault/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('OccasionVault') || c.url.includes('github.io')) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
