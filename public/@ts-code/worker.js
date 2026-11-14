// Service worker: lifecycle + dispatch of same-origin requests to HANDLERS.
import { typescript } from './typescript.js'

// Bump when handler code changes, to drop cached output.
const VERSION = 'v1'
const APP_CACHE_PREFIX = 'ts-code/'
const log = (...args) => console.info(`[sw ${VERSION}]`, ...args)

/** Names used before APP_CACHE_PREFIX existed; deleted on activate too. */
const isLegacyCache = (name) => name.startsWith('ts-transpile:') || name === 'ts-config'

/**
 * @typedef {object} Handler
 * @property {string} name
 * @property {(url: URL, request: Request) => boolean} match
 * @property {(event: FetchEvent, url: URL) => Promise<Response>} handle
 * @property {(event: ExtendableMessageEvent) => boolean} [message] true if handled.
 * @property {string[]} caches Cache names in use; others are deleted on activate.
 */

/** @type {Handler[]} */
const HANDLERS = [typescript({ cachePrefix: `${APP_CACHE_PREFIX}${VERSION}` })]

/** Deletes caches under APP_CACHE_PREFIX (and legacy ones) no handler uses. */
async function deleteUnusedCaches() {
  const used = new Set(HANDLERS.flatMap((h) => h.caches))
  for (const name of await caches.keys()) {
    if ((name.startsWith(APP_CACHE_PREFIX) && !used.has(name)) || isLegacyCache(name)) {
      log('deleting cache', name)
      await caches.delete(name)
    }
  }
}

self.addEventListener('install', () => {
  log('install, handlers:', HANDLERS.map((h) => h.name).join(', '))
  // No skipWaiting(): the page sends SKIP_WAITING.
})

self.addEventListener('activate', (event) => {
  log('activate')
  event.waitUntil(
    (async () => {
      await deleteUnusedCaches()
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  const { type } = event.data ?? {}
  if (type === 'SKIP_WAITING') {
    log('skipWaiting requested by page')
    self.skipWaiting()
    return
  }
  if (type === 'CLAIM') {
    log('claim requested by page')
    event.waitUntil(self.clients.claim())
    return
  }
  for (const handler of HANDLERS) if (handler.message?.(event)) return
})

self.addEventListener('fetch', (event) => {
  // An SSE stream through respondWith() would block activating new versions.
  if (event.request.headers.get('accept') === 'text/event-stream') return

  const url = new URL(event.request.url)
  if (url.origin !== location.origin) return

  const handler = HANDLERS.find((h) => h.match(url, event.request))
  event.respondWith(handler ? handler.handle(event, url) : fetch(event.request))
})
