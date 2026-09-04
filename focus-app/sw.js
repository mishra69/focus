const CACHE = 'focus-v13';
const ASSETS = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

const RETURN_TAG = 'focus-return';

// The browser decrypts the push payload and hands it to us here already-decrypted. We accept
// either the declarative shape ({ notification: {...} }) or a flat { title, body, ... }.
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = {}; }
  const n = data.notification || data;
  const tag = n.tag || 'focus';

  e.waitUntil((async () => {
    await self.registration.showNotification(n.title || 'Focus', {
      body: n.body || '',
      icon: n.icon || '/icon-192.png',
      badge: '/icon-192.png',
      tag,
      data: { url: n.navigate || n.url || '/' }
    });

    // "Tap to return" only helps while the user is away. If they beat it back, withdraw it
    // immediately rather than leaving it on the Lock Screen — a timer on the page can't win this
    // race, since it can't know when the push actually lands. Push requires showing something,
    // so this is show-then-withdraw rather than skip.
    if (tag === RETURN_TAG) {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      if (wins.some(c => c.focused || c.visibilityState === 'visible')) {
        const shown = await self.registration.getNotifications({ tag });
        shown.forEach(x => x.close());
      }
    }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      return self.clients.openWindow(url);
    })
  );
});

// If the push service rotates/invalidates the subscription, re-subscribe and re-register it.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try {
      const { key } = await (await fetch('/api/push/key')).json();
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key)
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub)
      });
    } catch (e) {}
  })());
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/')) return;

  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const fresh = fetch(e.request).then(response => {
          cache.put(e.request, response.clone());
          return response;
        });
        return cached || fresh;
      })
    )
  );
});
