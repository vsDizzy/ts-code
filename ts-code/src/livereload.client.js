// Live reload client: reloads on file changes and server restarts.
// For React apps (react in package.json dependencies) it does React Fast Refresh
// instead when it can; see window.__tsCodeHot below.
;(() => {
  const REFRESH_RUNTIME = 'https://esm.sh/react-refresh@0.17.0/runtime?dev'
  const sseUrl = document.currentScript.src.replace(/\.js$/, '')
  // This script is <base>@ts-code/livereload.js; changed files are relative to <base>.
  const base = new URL('../', sseUrl)

  /** @type {any} react-refresh/runtime, once setup() loaded it. */
  let refresh = null
  /** File path (e.g. /app/App.tsx) -> URLs it was imported as (e.g. /app/App). */
  const modules = new Map()

  /** Without the cache-busting `t` of a hot import. */
  const stripT = (url) => {
    const u = new URL(url)
    u.searchParams.delete('t')
    return u.href
  }

  // Used by register.js (setup; its presence means "dev server") and by modules
  // the service worker transpiled with the refresh transform (register, signature, loaded).
  window.__tsCodeHot = {
    /** Loads the refresh runtime if the app uses React; true if it did. Must run before react-dom loads. */
    async setup(pkg) {
      if (!pkg.dependencies?.react) return false
      try {
        refresh = await import(REFRESH_RUNTIME)
        refresh.injectIntoGlobalHook(window)
        return true
      } catch (err) {
        console.warn('[hot] could not load react-refresh; full reloads only', err)
        return false
      }
    },
    register: (type, id) => refresh?.register(type, id),
    signature: () => refresh?.createSignatureFunctionForTransform() ?? ((type) => type),
    loaded(file, url) {
      let urls = modules.get(file)
      if (!urls) modules.set(file, (urls = new Set()))
      urls.add(stripT(url))
    },
  }

  // Importers keep the old module, so only components (swapped by React) may change.
  const onlyComponents = (mod) => {
    const exports = Object.values(mod)
    return exports.length > 0 && exports.every((value) => refresh.isLikelyComponentType(value))
  }

  /**
   * Re-imports the changed modules and refreshes React. False if that can't
   * apply the change, so the page must reload.
   */
  const hotUpdate = async (files) => {
    if (!refresh) return false
    const urls = []
    for (const file of files) {
      if (!/\.tsx?$/.test(file) || file.endsWith('.d.ts')) return false
      const loaded = modules.get(new URL(file, base).pathname)
      if (!loaded) return false // not loaded by this page, or not through the SW
      urls.push(...loaded)
    }
    // The loaded modules first: import() of the same URL doesn't run them again,
    // while re-importing e.g. main.tsx would re-run its side effects.
    for (const url of urls) {
      if (!onlyComponents(await import(url))) {
        console.info('[hot] not only components exported:', url)
        return false
      }
    }
    const t = Date.now()
    for (const url of urls) {
      const next = new URL(url)
      next.searchParams.set('t', t)
      let mod
      try {
        mod = await import(next.href)
      } catch (err) {
        // E.g. a syntax error: keep the page and its state; the next save retries.
        console.error('[hot] update failed, fix and save again:', err)
        return true
      }
      if (!onlyComponents(mod)) {
        console.info('[hot] not only components exported now:', url)
        return false
      }
    }
    refresh.performReactRefresh()
    console.info('[hot] updated:', files)
    return true
  }

  const source = new EventSource(sseUrl)
  let bootId

  // A new boot id after reconnect means the server restarted.
  source.addEventListener('hello', (e) => {
    if (bootId && bootId !== e.data) location.reload()
    bootId = e.data
  })

  // Changes are applied in order: a reload can't overtake a hot update.
  let queue = Promise.resolve()
  source.addEventListener('reload', (e) => {
    const files = JSON.parse(e.data)
    queue = queue.then(async () => {
      if (await hotUpdate(files)) return
      console.info('[livereload] changed:', files)
      location.reload()
    })
  })
})()
