// NOVA service worker: caches the app shell for offline/instant load.
// Data is never cached: data/*, the GitHub API and the Calo site always go to the network.
const CACHE = 'nova-shell-v3';
const SHELL = [
  './', './index.html', './css/nova.css', './js/app.js', './js/connect.js', './js/n3d-config.js', './manifest.webmanifest',
  './3d/nova-3d.min.js', './3d/nova-3d.css', './3d/assets/calo-bunny.glb',
  './icons/logo.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './fonts/inter.woff2', './fonts/orbitron.woff2', './fonts/jetbrains-mono.woff2',
  './fonts/rajdhani-medium.woff2', './fonts/rajdhani-semibold.woff2', './fonts/rajdhani-bold.woff2',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('nova-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  // Only handle our own shell files. Everything else (data, APIs, other sites) passes straight through.
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  if (url.pathname.startsWith(scope.pathname + 'data/')) return;
  // Network first so updates show immediately; fall back to cache when offline.
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
