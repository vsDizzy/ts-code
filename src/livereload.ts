// Live reload: one recursive file watcher on the project, broadcasting every
// change over SSE to connected pages (client: public/livereload.js).
import { EventStream, type H3 } from 'h3'
import { watch } from 'node:fs'
import { posix } from 'node:path'

export interface LiveReloadOptions {
  /** Directory to watch. Default: current working directory. */
  root?: string
  /**
   * Globs (relative to `root`, forward slashes) whose changes are ignored.
   * A match on a directory ignores everything inside it.
   * Default: `['**\/node_modules']`.
   */
  ignore?: string[]
  /** SSE endpoint path. Default: `/__livereload`. */
  path?: string
}

/** Registers the SSE endpoint on `app` and starts watching for changes. */
export function liveReload(app: H3, options: LiveReloadOptions = {}) {
  const { root = '.', ignore = ['**/node_modules'], path = '/__livereload' } = options

  // New on every server start; clients reload if it differs after a reconnect.
  const bootId = Date.now().toString(36)

  const clients = new Set<EventStream>()
  let pending: ReturnType<typeof setTimeout> | undefined
  let changed = new Set<string>()

  // Used as fs.watch's `ignore` predicate instead of passing the globs directly:
  // Node's glob matching has no `dot` option, so `*`/`**` never match segments
  // starting with "." and "**/node_modules/**" would miss everything under
  // node_modules/.pnpm. Like .gitignore, a path is ignored if it or any parent
  // directory matches a glob. Watch passes relative paths with OS separators.
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

  return watcher
}
