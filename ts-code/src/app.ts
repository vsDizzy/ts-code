import { H3, redirect, serve, serveStatic } from 'h3'
import { readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { RUNTIME_DIR, RUNTIME_NAME } from './env.ts'
import { gitignore } from './gitignore.ts'
import { liveReload } from './livereload.ts'

export interface ServerOptions {
  /** Client folder (index.html, package.json, tsconfig.json). Default: ".". */
  root?: string
  /** URL path the client is served under. Default: "/". */
  base?: string
  port?: number
}

/** "app", "/app", "app/" -> "/app/"; "" -> "/". */
const normalizeBase = (base: string) => {
  const trimmed = base.replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}/` : '/'
}

/** Serves `root` at `base`, the runtime at `<base>@<name>/`, with live reload of `root`. */
export async function startServer({ root = '.', base = '/', port = 3000 }: ServerOptions = {}) {
  root = resolve(root)
  base = normalizeBase(base)
  const runtimePath = `${base}${RUNTIME_NAME}/`

  // New rules change what is served, so reload the page too.
  const isIgnored = gitignore(root, () => reload('.gitignore'))

  const app = new H3()
  // Only client files; runtime and server changes need a manual reload / restart.
  const { inject, reload } = liveReload(app, { root, ignore: isIgnored, path: `${runtimePath}livereload` })

  /** `path` inside `dir`, or undefined if it escapes it. */
  const inside = (dir: string, path: string) => {
    const file = join(dir, path)
    const rel = relative(dir, file)
    return rel.startsWith('..') || rel.startsWith(sep) ? undefined : file
  }

  /** Request path -> file on disk: runtime first, then the client minus .gitignore. */
  const toFile = (id: string) => {
    if (id.startsWith(runtimePath)) return inside(RUNTIME_DIR, id.slice(runtimePath.length))
    if (!id.startsWith(base)) return undefined
    const path = id.slice(base.length)
    return isIgnored(path) ? undefined : inside(root, path)
  }
  const isHtml = (id: string) => id.endsWith('.html')

  app.use((event) => {
    const { pathname } = event.url
    // "/" and "/app" -> "/app/": the page must be inside the worker's scope.
    if (base !== '/' && (pathname === '/' || pathname === base.slice(0, -1))) return redirect(base)
    // The worker script lives under <base>@<name>/ but controls all of <base>.
    if (pathname === `${runtimePath}worker.js`) event.res.headers.set('service-worker-allowed', base)

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
  console.info(`Serving ${root} on:`, new URL(base, server.url).href)
  return server
}
