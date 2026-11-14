import { H3, serve, serveStatic } from 'h3'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { liveReload } from './livereload.ts'

const app = new H3()

const { inject } = liveReload(app, { ignore: ['**/node_modules'] })

const toFile = (id: string) => join('public', id)
const isHtml = (id: string) => id.endsWith('.html')

app.use((event) => {
  return serveStatic(event, {
    fallthrough: true,
    indexNames: ['/index.html'],
    getContents: async (id) => (isHtml(id) ? inject(await readFile(toFile(id), 'utf8')) : readFile(toFile(id))),
    getMeta: async (id) => {
      const stats = await stat(toFile(id)).catch(() => {})
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

const server = serve(app, { port: 3000 })
await server.ready()

const url = new URL(server.url!)
if (url.hostname === '[::]' || url.hostname === '0.0.0.0') url.hostname = 'localhost'
console.info('Started server on:', url.href)
