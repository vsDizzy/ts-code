// SW handler: *.ts / *.tsx -> JavaScript, with the page's tsconfig.
// Also extensionless module imports (./lib -> lib.ts, then lib.tsx) unless
// the tsconfig sets allowImportingTsExtensions, and .js module imports with no
// such file (./lib.js -> lib.ts, then lib.tsx), as TypeScript resolves them.
// Pinned to 6.x: 7.x (native Go compiler) has no JS API.
import ts from 'https://esm.sh/typescript@6.0.3'
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

/** A module import whose last path segment has no extension, e.g. /app/lib. */
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
      const configText = await loadConfig(configCache, event.clientId)
      const config = parseConfig(configText)
      // Output depends on the source AND the options, so they're in the key.
      const variant = await sha256(JSON.stringify([DEFAULT_COMPILER_OPTIONS, configText]))

      // Keyed by the real file, so /app/lib and /app/lib.ts share one cache entry.
      const serve = (fileUrl) =>
        serveTransformed({
          url: fileUrl,
          cacheName,
          variant,
          transform: (source) => config.error ? config : transpile(source, fileUrl.pathname, config.options),
        })

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
        saveConfig(configCache, event.source.url, event.data.config).then(() =>
          event.ports[0]?.postMessage('ok'),
        ),
      )
      return true
    },
  }
}

// --- tsconfig ------------------------------------------------------------------

async function saveConfig(cacheName, pageUrl, configText) {
  const cache = await caches.open(cacheName)
  if (configText == null) await cache.delete(pageUrl)
  else await cache.put(pageUrl, new Response(configText))
}

/** tsconfig text of the page that made the request, or null if it has none. */
async function loadConfig(cacheName, clientId) {
  const client = clientId && (await self.clients.get(clientId))
  if (!client) return null
  const res = await (await caches.open(cacheName)).match(client.url)
  return res ? res.text() : null
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

/** @returns {import('./transform.js').TransformResult} */
function transpile(source, fileName, compilerOptions) {
  // fileName's extension decides whether JSX is parsed (.tsx).
  const out = ts.transpileModule(source, { fileName, compilerOptions, reportDiagnostics: true })
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) return { error: ts.formatDiagnostics(errors, diagnosticsHost) }
  return { body: out.outputText, contentType: 'text/javascript; charset=utf-8' }
}
