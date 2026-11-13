// Service worker. For now fetch is a pure pass-through to the network.
// Update flow (page side): see public/sw-register.js.
//
// The browser re-downloads this file on every page load and treats ANY byte
// change as a new version, so VERSION is only for telling versions apart in logs.
const VERSION = 'v1'
const log = (...args) => console.info(`[sw ${VERSION}]`, ...args)

self.addEventListener('install', () => {
  log('install')
  // No skipWaiting() here: a new version waits until the page tells it to take
  // over (SKIP_WAITING below), so the switch happens at a moment the page controls.
})

self.addEventListener('activate', (event) => {
  log('activate')
  // Take control of already open pages right away (incl. the page that
  // registered us on first install), instead of only after their next load.
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    log('skipWaiting requested by page')
    self.skipWaiting()
  }
})

self.addEventListener('fetch', (event) => {
  // Pass-through: respond with whatever the network returns.
  event.respondWith(fetch(event.request))
})
