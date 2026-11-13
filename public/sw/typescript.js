// Service worker handler: *.ts / *.tsx (same origin, GET) -> JavaScript.
//
// Compiler options = DEFAULT_COMPILER_OPTIONS + the page's
// <script type="tsconfig">{ "compilerOptions": ... }</script>, which
// sw-register.js sends here (TSCONFIG message) before any ts script runs.
//
// TypeScript 6.x is the last release with a JS API (7.x is the native Go
// compiler), so it's pinned here.
import ts from 'https://esm.sh/typescript@6.0.3'
import { deleteOldCaches, serveTransformed, sha256 } from './transform.js'

const CACHE_PREFIX = 'ts-transpile:'
/** Per-page tsconfig, keyed by page URL. */
const CONFIG_CACHE = 'ts-config'

/** Merged under the page's tsconfig compilerOptions. */
const DEFAULT_COMPILER_OPTIONS = {
  target: 'esnext',
  module: 'esnext',
  inlineSourceMap: true,
  inlineSources: true,
}

/**
 * @param {object} options
 * @param {string} options.version Service worker VERSION. Part of the cache name,
 *   so bumping it drops all cached output, e.g. after changing this handler's code
 *   (unchanged sources would otherwise keep getting 304 -> old output).
 * @returns {import('../sw.js').Handler}
 */
export function typescript({ version }) {
  // Invalidated by: SW VERSION, TypeScript version (cache name);
  // compiler options (variant hash below); source changes (304 revalidation).
  const cacheName = `${CACHE_PREFIX}${version}:${ts.version}`

  return {
    name: `typescript ${ts.version}`,

    match: (url, request) =>
      request.method === 'GET' && url.origin === location.origin && /\.tsx?$/.test(url.pathname),

    async handle(event, url) {
      const configText = await loadConfig(event.clientId)
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
      // Persisted, not kept in memory: the browser may stop the worker at any
      // time and later restart it for a fetch.
      event.waitUntil(
        saveConfig(event.source.url, event.data.config).then(() => event.ports[0]?.postMessage('ok')),
      )
      return true
    },

    // Drop output of other SW / TypeScript versions.
    activate: () => deleteOldCaches(CACHE_PREFIX, cacheName),
  }
}

// --- tsconfig ------------------------------------------------------------------

async function saveConfig(pageUrl, configText) {
  const cache = await caches.open(CONFIG_CACHE)
  if (configText == null) await cache.delete(pageUrl)
  else await cache.put(pageUrl, new Response(configText))
}

/** tsconfig text of the page that made the request, or null if it has none. */
async function loadConfig(clientId) {
  const client = clientId && (await self.clients.get(clientId))
  if (!client) return null
  const res = await (await caches.open(CONFIG_CACHE)).match(client.url)
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
    try {
      config = JSON.parse(configText)
    } catch (err) {
      return { error: `<script type="tsconfig">: invalid JSON: ${err.message}` }
    }
  }

  const converted = ts.convertCompilerOptionsFromJson(
    { ...DEFAULT_COMPILER_OPTIONS, ...config.compilerOptions },
    '/',
  )
  if (converted.errors.length) {
    return { error: '<script type="tsconfig">:\n' + ts.formatDiagnostics(converted.errors, diagnosticsHost) }
  }

  const out = ts.transpileModule(source, {
    fileName,
    compilerOptions: converted.options,
    reportDiagnostics: true,
  })
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) return { error: ts.formatDiagnostics(errors, diagnosticsHost) }
  return { body: out.outputText, contentType: 'text/javascript; charset=utf-8' }
}
