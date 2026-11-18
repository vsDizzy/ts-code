// Live reload (dev only): file watcher -> SSE -> livereload.client.js.
import { EventStream, type H3 } from 'h3'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { RUNTIME_NAME } from './env.ts'

const CLIENT_FILE = new URL('./livereload.client.js', import.meta.url)

export interface LiveReloadOptions {
  /** Directory to watch. Default: current working directory. */
  root?: string
  /** True for paths (relative to `root`) whose changes are ignored. */
  ignore?: (path: string) => boolean
  /** SSE endpoint path; the client script is served at `${path}.js`. Default: `/@<package name>/livereload`. */
  path?: string
}

/** Registers the SSE endpoint and client script, starts the watcher. */
export function liveReload(app: H3, options: LiveReloadOptions = {}) {
  const { root = '.', ignore = () => false, path = `/${RUNTIME_NAME}/livereload` } = options

  // New on every server start; clients reload if it differs after a reconnect.
  const bootId = Date.now().toString(36)

  const clients = new Set<EventStream>()
  let pending: ReturnType<typeof setTimeout> | undefined
  let changed = new Set<string>()

  /** Queues a reload of all clients; `file` (relative to `root`) is listed in the event. */
  const reload = (file: string) => {
    changed.add(file.replaceAll('\\', '/'))
    // Editors emit several events per save; coalesce them into one reload.
    clearTimeout(pending)
    pending = setTimeout(() => {
      const files = [...changed]
      changed = new Set()
      for (const client of clients) {
        client.push({ event: 'reload', data: JSON.stringify(files) }).catch(() => {})
      }
    }, 100)
  }

  const watcher = watch(root, { recursive: true, ignore }, (_type, filename) => {
    if (filename) reload(filename.toString())
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

  return { watcher, inject, reload }
}
