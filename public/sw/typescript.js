// Service worker handler: *.ts / *.tsx (GET; sw.js only passes same-origin
// requests to handlers) -> JavaScript.
//
// Compiler options = DEFAULT_COMPILER_OPTIONS + compilerOptions of the
// tsconfig.json next to the page (JSONC: comments and trailing commas are fine),
// which sw-register.js sends here (TSCONFIG message) before the app starts.
//
// TypeScript 6.x is the last release with a JS API (7.x is the native Go
// compiler), so it's pinned here.
import ts from 'https://esm.sh/typescript@6.0.3'
import { serveTransformed, sha256 } from './transform.js'

/** Merged under the page's tsconfig compilerOptions. */
const DEFAULT_COMPILER_OPTIONS = {
  target: 'esnext',
  module: 'esnext',
  inlineSourceMap: true,
  inlineSources: true,
}

/**
 * @param {object} options
 * @param {string} options.cachePrefix Prefix for this handler's cache names,
 *   e.g. "ts-code/v1". It contains the SW VERSION, so bumping that drops all
 *   cached output, e.g. after changing this handler's code (unchanged sources
 *   would otherwise keep getting 304 -> old output).
 * @returns {import('../sw.js').Handler}
 */
export function typescript({ cachePrefix }) {
  // Transpiled output. Invalidated by: SW VERSION, TypeScript version (cache
  // name); compiler options (variant hash below); source changes (304 revalidation).
  const cacheName = `${cachePrefix}/ts:${ts.version}`
  // Per-page tsconfig, keyed by page URL. Persisted, not kept in memory: the
  // browser may stop the worker at any time and later restart it for a fetch.
  // Dropped with the SW version; pages resend it on every load (sw-register.js).
  const configCache = `${cachePrefix}/tsconfig.json`

  return {
    name: `typescript ${ts.version}`,

    caches: [cacheName, configCache],

    match: (url, request) => request.method === 'GET' && /\.tsx?$/.test(url.pathname),

    async handle(event, url) {
      const configText = await loadConfig(configCache, event.clientId)
      return serveTransformed({
        url,
        cacheName,
        // Output depends on the source AND the options, so they're in the key.
        variant: await sha256(JSON.stringify([DEFAULT_COMPILER_OPTIONS, configText])),
        transform: (source) => transpile(source, url.pathname, configText),
      })
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

// --- transpile -----------------------------------------------------------------

const diagnosticsHost = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: () => '/',
  getNewLine: () => '\n',
}

/** @returns {import('./transform.js').TransformResult} */
function transpile(source, fileName, configText) {
  let config = {}
  if (configText) {
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

  const out = ts.transpileModule(source, {
    fileName,
    compilerOptions: converted.options,
    reportDiagnostics: true,
  })
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) return { error: ts.formatDiagnostics(errors, diagnosticsHost) }
  return { body: out.outputText, contentType: 'text/javascript; charset=utf-8' }
}
