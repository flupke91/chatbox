/*
 * Chatbox PWA service worker.
 *
 * Two jobs:
 *  - Navigation fallback: the app uses history routing (/guide, /session/<id>). A plain static
 *    host answers those paths with 404, so a refresh — or an iOS home-screen resume, which
 *    restores the last URL — would show a blank error page. Serve the app shell instead.
 *  - Runtime caching: keeps the shell, hashed bundles and the sql.js wasm available offline.
 *    The knowledge-base SQLite file lives in IndexedDB and never passes through here.
 */
const CACHE = 'chatbox-rag-v2'
const SHELL = '/index.html'
const PRECACHE = ['/', SHELL, '/manifest.webmanifest', '/logo192.png', '/logo512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request)
    if (response.ok) return response
  } catch {
    // offline: fall through to the cached shell
  }
  const cached = await caches.match(SHELL)
  return cached || fetch(SHELL)
}

async function cacheFirstAsset(request) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok && response.type === 'basic') {
    const copy = response.clone()
    caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined)
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // Only same-origin app assets; model API calls must never be cached or intercepted.
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request))
    return
  }
  event.respondWith(cacheFirstAsset(request))
})
