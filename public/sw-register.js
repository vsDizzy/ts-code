// Registers /sw.js and drives its lifecycle:
//
//   first visit:  install -> activate -> clients.claim() takes over this page (no reload)
//   update:       page load triggers an update check -> new worker installs ->
//                 "installed" (waiting) -> we send SKIP_WAITING -> it activates ->
//                 controllerchange -> reload once, so the page runs under the new worker
//
// Exposes `window.swControlled`: a promise that resolves once this page is
// controlled by the service worker, i.e. its requests go through the SW's fetch
// handler. It also resolves (with a warning) when that can't happen, so code
// waiting on it always runs.
//
// <script type="ts" src="..."> (or with inline code): the browser ignores
// unknown script types, so these stay inert until swControlled resolves; then
// each is swapped for a real <script type="module"> with the same attributes,
// so the app and everything it loads goes through the SW (which transpiles
// .ts/.tsx).
//
// <script type="tsconfig.json">{ "compilerOptions": { ... } }</script>: sent to the
// SW before the ts scripts start, and used to transpile this page's .ts files.
;(() => {
  const log = (...args) => console.info('[sw-register]', ...args)
  const warn = (...args) => console.warn('[sw-register]', ...args)

  const { promise: controlled, resolve: resolveControlled } = Promise.withResolvers()
  window.swControlled = controlled

  // Hands this page's tsconfig to the controlling SW and waits for it to be stored.
  const sendTsConfig = async () => {
    const controller = navigator.serviceWorker?.controller
    if (!controller) {
      warn('no service worker; <script type="ts"> will load untranspiled')
      return
    }
    const config = document.querySelector('script[type="tsconfig.json"]')?.textContent ?? null
    const { port1, port2 } = new MessageChannel()
    const { promise: ack, resolve } = Promise.withResolvers()
    port1.onmessage = resolve
    controller.postMessage({ type: 'TSCONFIG', config }, [port2])
    // An older SW version may not know TSCONFIG; don't hang the page on it.
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 2000))
    if ((await Promise.race([ack, timeout])) === 'timeout') warn('service worker did not ack tsconfig')
  }

  controlled.then(async () => {
    await sendTsConfig()
    for (const placeholder of document.querySelectorAll('script[type="ts"]')) {
      const script = document.createElement('script')
      for (const { name, value } of placeholder.attributes) script.setAttribute(name, value)
      script.type = 'module'
      script.textContent = placeholder.textContent
      placeholder.replaceWith(script)
    }
  })

  if (!('serviceWorker' in navigator)) {
    warn('service workers not supported; continuing without one')
    resolveControlled()
    return
  }
  const sw = navigator.serviceWorker

  // Already controlled (any visit after the first one).
  if (sw.controller) resolveControlled()

  // A controllerchange only means "new version" if a worker already controlled
  // this page. On first install clients.claim() fires it too; no reload needed.
  let hadController = !!sw.controller
  let reloading = false
  sw.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true
      log('page is now controlled by the service worker')
      resolveControlled()
      return
    }
    if (reloading) return
    reloading = true
    log('new version took control, reloading')
    location.reload()
  })

  // Tell a waiting worker to activate now instead of after all tabs are closed.
  const activate = (worker) => {
    log('update installed, activating it')
    worker.postMessage({ type: 'SKIP_WAITING' })
  }

  const tracked = new WeakSet()
  const track = (reg, worker) => {
    if (!worker || tracked.has(worker)) return
    tracked.add(worker)
    worker.addEventListener('statechange', () => {
      log('state:', worker.state)
      // "installed" = done installing, now waiting. If an older version is
      // active it's an update; otherwise it's the first install and it will
      // activate on its own.
      if (worker.state === 'installed' && reg.active) activate(worker)
      if (worker.state === 'redundant') {
        log('install failed or replaced')
        if (!sw.controller) {
          warn('first install failed; continuing without a service worker')
          resolveControlled()
        }
      }
    })
  }

  // type: 'module' — sw.js uses static `import` (TypeScript from esm.sh).
  // updateViaCache: 'none' — check sw.js (and its imports) against the server
  // on every update check, bypassing the HTTP cache.
  sw.register('/sw.js', { type: 'module', updateViaCache: 'none' })
    .then((reg) => {
      // A version that finished installing during an earlier visit and is still
      // waiting (e.g. that tab was closed before it could activate).
      if (reg.waiting && reg.active) activate(reg.waiting)
      track(reg, reg.installing)
      reg.addEventListener('updatefound', () => {
        log('update found')
        track(reg, reg.installing)
      })
      // An active worker exists but doesn't control us and nothing is being
      // installed: a hard reload (Ctrl+F5 / Shift+F5) loads the page bypassing
      // the SW, and the page would stay uncontrolled. Ask the active worker to
      // claim it; the resulting controllerchange resolves swControlled above.
      // (With an install/waiting worker in flight, its activate claims us anyway.)
      if (!sw.controller && reg.active && !reg.installing && !reg.waiting) {
        log('page not controlled (hard reload), asking the service worker to claim it')
        reg.active.postMessage({ type: 'CLAIM' })
        setTimeout(() => {
          if (sw.controller) return
          warn('service worker did not take control; continuing without it')
          resolveControlled()
        }, 2000)
      }
    })
    .catch((err) => {
      console.error('[sw-register] registration failed:', err)
      resolveControlled()
    })
})()
