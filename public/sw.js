const CACHE = 'crm-r2x-v4';
const STATIC = ['/', '/index.html', '/login', '/manifest.json', '/icon-192.png', '/icon-512.png', '/portal.html'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC).catch(() => {}))
  );
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

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // API e portal sempre vão para rede — nunca cache
  if (url.includes('/api/') || url.includes('/portal/')) return;
  // Stale-while-revalidate para index.html — sempre busca versão nova em background
  if (url.endsWith('/') || url.endsWith('/index.html') || url.endsWith('/login')) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          const networkFetch = fetch(e.request).then(response => {
            if (response.status === 200) cache.put(e.request, response.clone());
            return response;
          }).catch(() => cached);
          return cached || networkFetch;
        })
      )
    );
    return;
  }
  // Cache-first para demais assets estáticos (ícones, manifesto)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (e.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
