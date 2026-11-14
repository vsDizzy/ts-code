// Live reload (dev only): file watcher -> SSE -> livereload.client.js.
import { EventStream, type H3 } from 'h3'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { posix } from 'node:path'
import { RUNTIME_PATH } from './env.ts'

const CLIENT_FILE = new URL('./livereload.client.js', import.meta.url)

export interface LiveReloadOptions {
  /** Directory to watch. Default: current working directory. */
  root?: string
  /** Ignored globs relative to `root`; a matching directory is ignored entirely. */
  ignore?: string[]
  /** SSE endpoint path; the client script is served at `${path}.js`. Default: `/@<package name>/livereload`. */
  path?: string
}

/** Registers the SSE endpoint and client script, starts the watcher. */
export function liveReload(app: H3, options: LiveReloadOptions = {}) {
  const { root = '.', ignore = ['**/node_modules'], path = `${RUNTIME_PATH}/livereload` } = options

  // New on every server start; clients reload if it differs after a reconnect.
  const bootId = Date.now().toString(36)

  const clients = new Set<EventStream>()
  let pending: ReturnType<typeof setTimeout> | undefined
  let changed = new Set<string>()

  // A predicate, not raw globs: Node's globs can't match dot segments (.pnpm).
  const isIgnored = (filename: string) => {
    const parts = filename.split(/[\\/]/)
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/')
      if (ignore.some((glob) => posix.matchesGlob(prefix, glob))) return true
    }
    return false
  }

  const watcher = watch(root, { recursive: true, ignore: isIgnored }, (_type, filename) => {
    if (!filename) return
    changed.add(filename.toString().replaceAll('\\', '/'))
    // Editors emit several events per save; coalesce them into one reload.
    clearTimeout(pending)
    pending = setTimeout(() => {
      const files = [...changed]
      changed = new Set()
      for (const client of clients) {
        client.push({ event: 'reload', data: JSON.stringify(files) }).catch(() => {})
      }
    }, 100)
  })

  app.get(path, (event) => {
    const stream = new EventStream(event)
    clients.add(stream)
    stream.onClosed(() => clients.delete(stream))
    stream.push({ event: 'hello', data: bootId })
    return stream
  })

  // Read on every request, so edits to the client apply without a restart.
  app.get(`${path}.js`, async (event) => {
    event.res.headers.set('content-type', 'text/javascript; charset=utf-8')
    return readFile(CLIENT_FILE, 'utf8')
  })

  const tag = `<script src="${path}.js" defer></script>`
  /** Adds the client script to an HTML page, at the end of <head> if there is one. */
  const inject = (html: string) => (html.includes('</head>') ? html.replace('</head>', `  ${tag}\n</head>`) : tag + html)

  return { watcher, inject }
}
