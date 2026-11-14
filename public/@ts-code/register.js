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
// Then starts the app, described by two files next to the page (the client is
// its own project, separate from the server's root package.json):
//
//   tsconfig.json  sent to the SW, which transpiles this page's .ts/.tsx with it
//   package.json   "dependencies" -> import map (esm.sh), "main" -> entry point
//
// Order matters: tsconfig is stored and the import map is in the DOM before
// "main" is imported. An import map may be added from JS as long as no module
// has been loaded yet, and none is: the page has no module scripts of its own.
;(() => {
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

  // Each dependency gets its main entry and a prefix for subpaths
  // ("react-dom/client"), both from esm.sh at the exact version given. esm.sh
  // resolves a package's own imports (react-dom -> react) to the same URLs, so
  // there's one copy of each as long as the versions here agree.
  // Plus the package's own name, like a self-reference in Node: "app" -> main,
  // "app/..." -> files next to package.json.
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

  // /sw.js only imports @ts-code/worker.js; it sits at the root so the scope
  // (the script's folder) is the whole site.
  // type: 'module' — the worker uses static `import` (TypeScript from esm.sh).
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
      console.error('[ts-code] registration failed:', err)
      resolveControlled()
    })
})()
