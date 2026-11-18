// The client's .gitignore as a predicate, shared by the watcher and the HTTP server.
import ignore, { type Ignore } from 'ignore'
import { readFileSync, watch } from 'node:fs'
import { join } from 'node:path'

const FILE = '.gitignore'

/** Always ignored, whatever .gitignore says. */
const ALWAYS = ['.git', FILE]

/**
 * `<root>/.gitignore` as a predicate (full gitignore syntax via the `ignore`
 * package, as in ESLint/Prettier; nested .gitignore files are not read). Rules are
 * re-read when the file changes, then `onChange` is called; without `onChange` the
 * file is read once. The predicate takes a path relative to `root` ("/" or "\"
 * separated).
 */
export function gitignore(root: string, onChange?: () => void): (path: string) => boolean {
  let ig: Ignore
  const load = () => {
    let text = ''
    try {
      text = readFileSync(join(root, FILE), 'utf8')
    } catch {}
    ig = ignore().add(ALWAYS).add(text)
  }
  load()

  // The folder, not the file: editors that save via rename would end a file watch.
  if (onChange) {
    watch(root, (_type, filename) => {
      if (filename?.toString() !== FILE) return
      load()
      console.info(`[ts-code] ${FILE} changed, rules reloaded`)
      onChange()
    }).unref()
  }

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
