// The client's .gitignore as a predicate, shared by the watcher and the HTTP server.
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

/** Always ignored, whatever .gitignore says. */
const ALWAYS = ['.git', '.gitignore']

interface Rule {
  glob: string
  /** No "/" in the pattern: matches a path segment at any depth. */
  anySegment: boolean
}

/**
 * Subset of gitignore syntax: comments, "/" anchoring, trailing "/" (treated like
 * any path), globs. Not supported: "!" negation (skipped with a warning), escapes,
 * .gitignore files in subfolders.
 */
const parse = (text: string): Rule[] => {
  const rules: Rule[] = []
  for (let line of text.split(/\r?\n/)) {
    line = line.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('!')) {
      console.warn(`[ts-code] .gitignore: negation is not supported, skipping "${line}"`)
      continue
    }
    line = line.replace(/\/+$/, '')
    const anchored = line.includes('/')
    rules.push({ glob: anchored ? line.replace(/^\//, '') : line, anySegment: !anchored })
  }
  return rules
}

/**
 * Reads `<root>/.gitignore` once. The returned predicate takes a path relative to
 * `root` ("/" or "\" separated) and is true if it, or any folder above it, is ignored.
 */
export function gitignore(root: string): (path: string) => boolean {
  let text = ''
  try {
    text = readFileSync(join(root, '.gitignore'), 'utf8')
  } catch {}
  const rules = [...ALWAYS.map((glob) => ({ glob, anySegment: false })), ...parse(text)]

  return (path) => {
    const parts = path.split(/[\\/]/).filter(Boolean)
    for (let i = 1; i <= parts.length; i++) {
      // Segment by segment: Node's "**" doesn't match dot folders.
      const segment = parts[i - 1]
      const prefix = parts.slice(0, i).join('/')
      for (const rule of rules) {
        if (rule.anySegment ? posix.matchesGlob(segment, rule.glob) : posix.matchesGlob(prefix, rule.glob)) return true
      }
    }
    return false
  }
}
