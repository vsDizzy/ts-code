// Service worker (registered as a module, see public/sw-register.js).
//
// Lifecycle + request dispatch. Same-origin requests are offered to HANDLERS in
// order; the first whose match() returns true serves it. Anything unmatched
// passes through to the network unchanged. Other origins and Server-Sent Events
// aren't intercepted at all.
//
// The browser re-downloads this file (and its imports) on every page load and
// treats ANY byte change as a new version. VERSION is in the logs and in the
// handlers' cache names: bump it when changing handler code (sw/*.js), so
// output cached by the old code is dropped on activate.
//
// Cache names are paths: `${APP_CACHE_PREFIX}${VERSION}/<handler's own>`,
// e.g. "ts-code/v1/ts:6.0.3". On activate every cache under APP_CACHE_PREFIX
// that no current handler lists is deleted, so caches of older SW versions,
// renamed caches and caches of removed handlers all go away.
import { typescript } from './sw/typescript.js'

const VERSION = 'v1'
const APP_CACHE_PREFIX = 'ts-code/'
const log = (...args) => console.info(`[sw ${VERSION}]`, ...args)

/** Names used before APP_CACHE_PREFIX existed; deleted on activate too. */
const isLegacyCache = (name) => name.startsWith('ts-transpile:') || name === 'ts-config'

/**
 * @typedef {object} Handler
 * @property {string} name For logs.
 * @property {(url: URL, request: Request) => boolean} match Whether to serve this
 *   request. Only same-origin requests get here.
 * @property {(event: FetchEvent, url: URL) => Promise<Response>} handle
 * @property {(event: ExtendableMessageEvent) => boolean} [message] Handle a page
 *   message; return true if it was this handler's.
 * @property {string[]} caches Cache Storage names this handler uses (all under
 *   the cachePrefix it was given). Any other cache under APP_CACHE_PREFIX is
 *   deleted on activate.
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
  // No skipWaiting() here: a new version waits until the page tells it to take
  // over (SKIP_WAITING below), so the switch happens at a moment the page controls.
})

self.addEventListener('activate', (event) => {
  log('activate')
  event.waitUntil(
    (async () => {
      await deleteUnusedCaches()
      // Take control of already open pages right away (incl. the page that
      // registered us on first install), instead of only after their next load.
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
    // Sent by a page loaded with a hard reload (Ctrl+F5), which the browser
    // leaves uncontrolled; claim() takes it over.
    log('claim requested by page')
    event.waitUntil(self.clients.claim())
    return
  }
  for (const handler of HANDLERS) if (handler.message?.(event)) return
})

self.addEventListener('fetch', (event) => {
  // Leave Server-Sent Events (e.g. /__livereload) to the browser. A stream
  // piped through respondWith() never finishes, which keeps this worker "busy":
  // the browser won't activate a new version (even after skipWaiting) until the
  // page that holds the stream unloads.
  if (event.request.headers.get('accept') === 'text/event-stream') return

  // Other origins (CDNs, APIs, ...) go straight to the network as well.
  const url = new URL(event.request.url)
  if (url.origin !== location.origin) return

  const handler = HANDLERS.find((h) => h.match(url, event.request))
  // Unmatched: pass-through, respond with whatever the network returns.
  event.respondWith(handler ? handler.handle(event, url) : fetch(event.request))
})
