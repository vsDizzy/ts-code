// Registers worker.js (next to this script) for the base URL, then starts the
// app from ./package.json and ./tsconfig.json.
;(() => {
  // Read now: currentScript is only set while this script runs synchronously.
  const workerUrl = new URL('worker.js', document.currentScript.src)
  // This script is served at <base>@ts-code/register.js.
  const scope = new URL('../', document.currentScript.src).href

  const log = (...args) => console.info('[ts-code]', ...args)
  const warn = (...args) => console.warn('[ts-code]', ...args)

  const { promise: controlled, resolve: resolveControlled } = Promise.withResolvers()
  window.swControlled = controlled

  /** Text of `name` next to this page, or null if there's none. */
  const loadText = async (name) => {
    const res = await fetch(new URL(name, location.href))
    return res.ok ? res.text() : null
  }

  // Hands this page's tsconfig to the controlling SW and waits for it to be stored.
  const sendTsConfig = async (config) => {
    const controller = navigator.serviceWorker?.controller
    if (!controller) {
      warn('no service worker; .ts/.tsx will load untranspiled')
      return
    }
    const { port1, port2 } = new MessageChannel()
    const { promise: ack, resolve } = Promise.withResolvers()
    port1.onmessage = resolve
    controller.postMessage({ type: 'TSCONFIG', config }, [port2])
    // An older SW version may not know TSCONFIG; don't hang the page on it.
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 2000))
    if ((await Promise.race([ack, timeout])) === 'timeout') warn('service worker did not ack tsconfig')
  }

  // dependencies -> esm.sh; own name -> main and files next to package.json.
  const importMapOf = (pkg, pkgUrl) => {
    const imports = {}
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      imports[name] = `https://esm.sh/${name}@${version}`
      imports[`${name}/`] = `https://esm.sh/${name}@${version}/`
    }
    if (pkg.name) {
      if (pkg.main) imports[pkg.name] = new URL(pkg.main, pkgUrl).href
      imports[`${pkg.name}/`] = new URL('./', pkgUrl).href
    }
    return { imports }
  }

  const start = async () => {
    const pkgUrl = new URL('package.json', location.href)
    const [pkgText, tsconfig] = await Promise.all([loadText(pkgUrl), loadText('tsconfig.json')])
    await sendTsConfig(tsconfig)
    if (pkgText == null) return warn('no package.json next to the page; nothing to start')
    const pkg = JSON.parse(pkgText)

    const script = document.createElement('script')
    script.type = 'importmap'
    script.textContent = JSON.stringify(importMapOf(pkg, pkgUrl), null, 2)
    document.head.append(script)

    if (!pkg.main) return warn('package.json has no "main"; nothing to start')
    await import(new URL(pkg.main, pkgUrl).href)
  }

  controlled.then(start).catch((err) => console.error('[ts-code] failed to start the app:', err))

  if (!('serviceWorker' in navigator)) {
    warn('service workers not supported; continuing without one')
    resolveControlled()
    return
  }
  const sw = navigator.serviceWorker

  // Already controlled (any visit after the first one).
  if (sw.controller) resolveControlled()

  // On first install controllerchange comes from clients.claim(); no reload.
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

  // The base is above the script's folder; the server allows it with Service-Worker-Allowed.
  sw.register(workerUrl, { type: 'module', scope, updateViaCache: 'none' })
    .then((reg) => {
      // Waiting since an earlier visit.
      if (reg.waiting && reg.active) activate(reg.waiting)
      track(reg, reg.installing)
      reg.addEventListener('updatefound', () => {
        log('update found')
        track(reg, reg.installing)
      })
      // Hard reload (Ctrl+F5) leaves the page uncontrolled; ask the SW to claim it.
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
      console.error('[ts-code] registration failed:', err)
      resolveControlled()
    })
})()
