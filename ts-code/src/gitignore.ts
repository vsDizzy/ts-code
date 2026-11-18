// The client's .gitignore as a predicate, shared by the watcher and the HTTP server.
import ignore from 'ignore'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Always ignored, whatever .gitignore says. */
const ALWAYS = ['.git', '.gitignore']

/**
 * Reads `<root>/.gitignore` once (full gitignore syntax via the `ignore` package,
 * as in ESLint/Prettier; nested .gitignore files are not read). The returned
 * predicate takes a path relative to `root` ("/" or "\" separated).
 */
export function gitignore(root: string): (path: string) => boolean {
  let text = ''
  try {
    text = readFileSync(join(root, '.gitignore'), 'utf8')
  } catch {}
  const ig = ignore().add(ALWAYS).add(text)

  return (path) => {
    path = path.replaceAll('\\', '/').replace(/^\/+/, '')
    if (!path) return false
    try {
      // Callers don't know if a path is a folder; "dir/" patterns need the trailing slash.
      return ig.ignores(path) || ig.ignores(`${path}/`)
    } catch {
      // Paths ignore() rejects (e.g. with ".."): never serve or watch them.
      return true
    }
  }
}
