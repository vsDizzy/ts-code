import { H3, serve, serveStatic } from 'h3'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { liveReload } from './livereload.ts'

const app = new H3()

// SSE endpoint /__livereload + file watcher; see src/livereload.ts.
liveReload(app, { ignore: ['**/node_modules'] })

// Serve files from public/ at the site root: GET /index.html -> public/index.html.
// serveStatic passes the full request path as `id`.
const toFile = (id: string) => join('public', id)

app.use((event) => {
  return serveStatic(event, {
    // Let unmatched requests fall through to other routes / the default 404.
    fallthrough: true,
    indexNames: ['/index.html'],
    getContents: (id) => readFile(toFile(id)),
    getMeta: async (id) => {
      const stats = await stat(toFile(id)).catch(() => {})
      if (stats?.isFile()) {
        return {
          size: stats.size,
          // No mtime, so no Last-Modified: ETag only.
          // - Last-Modified has 1s precision, so two saves within the same
          //   second would still get a 304. The ETag uses full mtime precision.
          // - Browsers derive a heuristic freshness from Last-Modified when
          //   there's no Cache-Control, and serve such files from the HTTP cache
          //   without asking the server. Without it they revalidate every time.
          etag: `W/"${stats.size.toString(36)}-${stats.mtimeMs.toString(36)}"`,
        }
      }
    },
  })
})

const server = serve(app, { port: 3000 })
await server.ready()

// server.url is the raw bind address; "[::]" / "0.0.0.0" mean "all interfaces"
// and aren't openable in a browser, so show localhost instead.
const url = new URL(server.url!)
if (url.hostname === '[::]' || url.hostname === '0.0.0.0') url.hostname = 'localhost'
console.info('Started server on:', url.href)
