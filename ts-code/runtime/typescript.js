// SW handler: *.ts / *.tsx -> JavaScript, with the page's tsconfig; also resolves
// extensionless and .js module imports to .ts / .tsx.
// Pinned to 6.x: 7.x (native Go compiler) has no JS API.
import ts from 'https://esm.sh/typescript@6.0.3'
// The core takes our ts instance (the package entry would pull in node's crypto).
// Static: service workers can't use import().
import refreshTransformer from 'https://esm.sh/react-refresh-typescript@2.0.12/dist/core.js'
import { serveTransformed, sha256 } from './transform.js'

/** Merged under the page's tsconfig compilerOptions. */
const DEFAULT_COMPILER_OPTIONS = {
  target: 'esnext',
  module: 'esnext',
  inlineSourceMap: true,
  inlineSources: true,
}

const TS_FILE = /\.tsx?$/
/** Tried in order for an extensionless import; first non-404 wins. No index.ts:
 * served under /app/lib, its relative imports would resolve against /app/. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx']

/** e.g. /app/lib; skipped when the tsconfig sets allowImportingTsExtensions. */
const isExtensionlessImport = (url, request) =>
  request.destination === 'script' && /\/[^/.]+$/.test(url.pathname)

const JS_FILE = /\.js$/
/** A .js module import; served as is if the file exists, else from .ts / .tsx. */
const isJsImport = (url, request) => request.destination === 'script' && JS_FILE.test(url.pathname)

/**
 * @param {object} options
 * @param {string} options.cachePrefix e.g. "ts-code/v1"
 * @returns {import('./worker.js').Handler}
 */
export function typescript({ cachePrefix }) {
  const cacheName = `${cachePrefix}/ts:${ts.version}`
  // Per-page tsconfig; in Cache Storage because the SW may be restarted anytime.
  const configCache = `${cachePrefix}/tsconfig.json`

  return {
    name: `typescript ${ts.version}`,

    caches: [cacheName, configCache],

    match: (url, request) =>
      request.method === 'GET' &&
      (TS_FILE.test(url.pathname) || isExtensionlessImport(url, request) || isJsImport(url, request)),

    async handle(event, url) {
      const { configText, refresh } = await loadConfig(configCache, event.clientId)
      const config = parseConfig(configText)
      // Output depends on the source AND the options, so they're in the key.
      const variant = await sha256(JSON.stringify([DEFAULT_COMPILER_OPTIONS, configText, refresh]))

      // Keyed by the real file, so /app/lib and /app/lib.ts share one cache entry.
      // No query: a hot update imports App.tsx?t=..., which is the same file.
      const serve = (fileUrl) => {
        fileUrl = new URL(fileUrl)
        fileUrl.search = ''
        return serveTransformed({
          url: fileUrl,
          cacheName,
          variant,
          transform: (source) =>
            config.error ? config : transpile(source, fileUrl.pathname, config.options, refresh),
        })
      }

      if (TS_FILE.test(url.pathname)) return serve(url)

      // Probed on every request: a new, deleted or renamed file is picked up on the
      // next load, with no resolution cache to invalidate.
      /** First non-404 of `base` + each RESOLVE_EXTENSIONS entry, or null. */
      const resolve = async (base) => {
        for (const ext of RESOLVE_EXTENSIONS) {
          const candidate = new URL(url)
          candidate.pathname = base + ext
          const res = await serve(candidate)
          if (res.status !== 404) return res
          await res.body?.cancel()
        }
        return null
      }

      if (JS_FILE.test(url.pathname)) {
        // A real .js file wins; .ts / .tsx are only tried after a 404.
        const res = await fetch(event.request)
        if (res.status !== 404) return res
        return (await resolve(url.pathname.replace(JS_FILE, ''))) ?? res
      }

      if (config.options?.allowImportingTsExtensions) return fetch(event.request)
      return (await resolve(url.pathname)) ?? fetch(event.request)
    },

    message(event) {
      if (event.data?.type !== 'TSCONFIG') return false
      event.waitUntil(
        saveConfig(configCache, event.source.url, event.data.config, !!event.data.refresh).then(() =>
          event.ports[0]?.postMessage('ok'),
        ),
      )
      return true
    },
  }
}

// --- tsconfig ------------------------------------------------------------------

/** Stores the page's tsconfig text (null: none) and whether it wants React Refresh. */
async function saveConfig(cacheName, pageUrl, configText, refresh) {
  const cache = await caches.open(cacheName)
  await cache.put(pageUrl, Response.json({ configText, refresh }))
}

/** What saveConfig stored for the page that made the request. */
async function loadConfig(cacheName, clientId) {
  const client = clientId && (await self.clients.get(clientId))
  const res = client && (await (await caches.open(cacheName)).match(client.url))
  return res ? res.json() : { configText: null, refresh: false }
}

const diagnosticsHost = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: () => '/',
  getNewLine: () => '\n',
}

/** @type {Map<string | null, { options: ts.CompilerOptions } | { error: string }>} */
const parsedConfigs = new Map()

/** Compiler options from tsconfig text (null: defaults only), memoized by text. */
function parseConfig(configText) {
  let result = parsedConfigs.get(configText)
  if (result) return result

  result = (() => {
    let config = {}
    if (configText != null) {
      const parsed = ts.parseConfigFileTextToJson('tsconfig.json', configText)
      if (parsed.error) return { error: ts.formatDiagnostics([parsed.error], diagnosticsHost) }
      config = parsed.config ?? {}
    }
    const converted = ts.convertCompilerOptionsFromJson(
      { ...DEFAULT_COMPILER_OPTIONS, ...config.compilerOptions },
      '/',
      'tsconfig.json',
    )
    if (converted.errors.length) return { error: ts.formatDiagnostics(converted.errors, diagnosticsHost) }
    return { options: converted.options }
  })()

  // Each tsconfig edit adds an entry; keep the map from growing without bound.
  if (parsedConfigs.size >= 16) parsedConfigs.clear()
  parsedConfigs.set(configText, result)
  return result
}

// --- transpile -----------------------------------------------------------------

/** No hash: signatures stay readable, and a sync hash would need node's crypto. */
const reactRefresh = refreshTransformer({ ts })

/**
 * Appended to modules transpiled for React Refresh. The transform calls
 * $RefreshReg$ / $RefreshSig$; these hoisted functions hand them to the page's
 * window.__tsCodeHot (livereload.client.js), with ids from the file path so a
 * re-imported App.tsx?t=... updates the same components. Also reports the module
 * as loaded, so the page knows which URLs to re-import when the file changes.
 */
const refreshFooter = (file) => {
  const f = JSON.stringify(file)
  return [
    `function $RefreshReg$(type, id) { globalThis.__tsCodeHot?.register(type, ${f} + ' ' + id) }`,
    `function $RefreshSig$() { return globalThis.__tsCodeHot?.signature() ?? ((type) => type) }`,
    `globalThis.__tsCodeHot?.loaded(${f}, import.meta.url)`,
  ].join('\n')
}

/** Inserts `code` before the inline source map comment, so the mappings stay valid. */
const appendCode = (output, code) => {
  const at = output.lastIndexOf('\n//# sourceMappingURL=')
  return at < 0 ? `${output}\n${code}\n` : `${output.slice(0, at)}\n${code}${output.slice(at)}`
}

/** @returns {import('./transform.js').TransformResult} */
function transpile(source, fileName, compilerOptions, refresh) {
  // fileName's extension decides whether JSX is parsed (.tsx).
  const out = ts.transpileModule(source, {
    fileName,
    compilerOptions,
    reportDiagnostics: true,
    transformers: refresh ? { before: [reactRefresh] } : undefined,
  })
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) return { error: ts.formatDiagnostics(errors, diagnosticsHost) }
  const body = refresh ? appendCode(out.outputText, refreshFooter(fileName)) : out.outputText
  return { body, contentType: 'text/javascript; charset=utf-8' }
}
