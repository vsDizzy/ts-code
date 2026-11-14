// SW handler: *.ts / *.tsx -> JavaScript, with the page's tsconfig.
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
