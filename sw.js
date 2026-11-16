// 離線使用: keeps the app itself, the trip data already opened, and map tiles, so the app still opens and shows
// trips without a connection. The build id in this script's URL names the app cache; a new build replaces it.
const BUILD = new URL(self.location).searchParams.get('v') || 'dev';
const SHELL = `st-shell-${BUILD}`, DATA = 'st-data', TILES = 'st-tiles', MEDIA = 'st-media';

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    const list = await fetch('/precache.json', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ files: [] }));
    await c.addAll(['/app.html', ...list.files.map(f => `/${f}`)]).catch(() => undefined);
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('st-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trim(name, max) {
  const c = await caches.open(name), keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) await c.delete(k);
}
async function cacheFirst(req, name, max) {
  const c = await caches.open(name), hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') { await c.put(req, res.clone()); if (max) trim(name, max); }
  return res;
}
async function networkFirst(req, name, ms) {
  const c = await caches.open(name);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error('slow')), ms))]);
    if (res.ok) await c.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      // Offline: the plain app shell (app.html), never a pre-rendered company page.
      e.respondWith(fetch(req).catch(async () => (await caches.match('/app.html')) || Response.error()));
    } else if (url.pathname.startsWith('/assets/') || /\.(png|svg|webmanifest|woff2?)$/.test(url.pathname)) {
      e.respondWith(cacheFirst(req, SHELL));
    }
    return;
  }
  if (url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/rest/v1/')) e.respondWith(networkFirst(req, DATA, 6000));
  else if (url.hostname === 'tiles.openfreemap.org') e.respondWith(cacheFirst(req, TILES, 6000));
  else if (url.hostname === 'upload.wikimedia.org' || (url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/storage/v1/object/public/'))) e.respondWith(cacheFirst(req, MEDIA, 400));
  else if (url.hostname === 'fonts.gstatic.com' || url.hostname === 'fonts.googleapis.com') e.respondWith(cacheFirst(req, SHELL));
});

// Signing out clears what was kept for that account.
self.addEventListener('message', e => { if (e.data === 'clear-data') e.waitUntil(caches.delete(DATA)); });

// 推播通知: show what the push function sent; tapping opens the trip (or focuses an open window on it).
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || '慢慢玩', {
    body: d.body || '', tag: d.tag, renotify: !!d.tag, data: { url: d.url || '/app', ack: d.ack || '' }, icon: '/icon-192.png', badge: '/icon-192.png',
    // A morning call stays on screen until it is dismissed and buzzes longer than an ordinary notice.
    ...(String(d.tag || '').startsWith('wake-') ? { requireInteraction: true, silent: false, vibrate: [400, 200, 400, 200, 400, 200, 800, 300, 800] } : {}),
  }));
});
// A morning call that is tapped or swiped away tells the server, so it stops repeating.
const ack = n => {
  const u = n.data && n.data.ack; if (!u) return;
  let k = ''; try { k = new URL(u).searchParams.get('apikey') || ''; } catch { /* plain url */ }
  return fetch(u, { method: 'POST', headers: k ? { apikey: k, Authorization: 'Bearer ' + k } : {} }).catch(() => undefined);
};
self.addEventListener('notificationclose', e => { e.waitUntil(ack(e.notification) || Promise.resolve()); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.notification.data && e.notification.data.ack) e.waitUntil(ack(e.notification));
  const url = (e.notification.data && e.notification.data.url) || '/app';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) if ('focus' in w) { await w.navigate(url).catch(() => undefined); return w.focus(); }
    return self.clients.openWindow(url);
  })());
});
