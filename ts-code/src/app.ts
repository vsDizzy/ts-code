import { H3, serve, serveStatic } from 'h3'
import { readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { RUNTIME_DIR, RUNTIME_PATH } from './env.ts'
import { gitignore } from './gitignore.ts'
import { liveReload } from './livereload.ts'

export interface ServerOptions {
  /** Client folder (index.html, package.json, tsconfig.json). */
  root: string
  port?: number
}

/** Serves `root` plus the runtime at /@<name>/, with live reload of `root`. */
export async function startServer({ root, port = 3000 }: ServerOptions) {
  root = resolve(root)
  const isIgnored = gitignore(root)

  const app = new H3()
  // Only client files; runtime and server changes need a manual reload / restart.
  const { inject } = liveReload(app, { root, ignore: isIgnored })

  /** `path` inside `base`, or undefined if it escapes it. */
  const inside = (base: string, path: string) => {
    const file = join(base, path)
    const rel = relative(base, file)
    return rel.startsWith('..') || rel.startsWith(sep) ? undefined : file
  }

  /** Request path -> file on disk: runtime first, then the client minus .gitignore. */
  const toFile = (id: string) => {
    if (id.startsWith(`${RUNTIME_PATH}/`)) return inside(RUNTIME_DIR, id.slice(RUNTIME_PATH.length + 1))
    const path = id.slice(1)
    return isIgnored(path) ? undefined : inside(root, path)
  }
  const isHtml = (id: string) => id.endsWith('.html')

  app.use((event) => {
    // The worker script lives under /@<name>/ but controls the whole site.
    if (event.url.pathname === `${RUNTIME_PATH}/worker.js`) event.res.headers.set('service-worker-allowed', '/')

    return serveStatic(event, {
      fallthrough: true,
      indexNames: ['/index.html'],
      getContents: async (id) => {
        const file = toFile(id)!
        return isHtml(id) ? inject(await readFile(file, 'utf8')) : readFile(file)
      },
      getMeta: async (id) => {
        const file = toFile(id)
        const stats = file && (await stat(file).catch(() => {}))
        if (stats?.isFile()) {
          return {
            // HTML is modified by inject().
            size: isHtml(id) ? undefined : stats.size,
            // ETag only: Last-Modified has 1s precision and enables heuristic caching.
            etag: `W/"${stats.size.toString(36)}-${stats.mtimeMs.toString(36)}"`,
          }
        }
      },
    })
  })

  const server = serve(app, { port, hostname: 'localhost' })
  await server.ready()
  console.info(`Serving ${root} on:`, server.url)
  return server
}
