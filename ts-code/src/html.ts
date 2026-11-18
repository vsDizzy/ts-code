// HTML and runtime snippets shared by the dev server and the static export.
import { RUNTIME_NAME } from './env.ts'

/** File name of the service worker entry at the base root: `@<name>.sw.js`. */
export const SW_FILE = `${RUNTIME_NAME}.sw.js`

/**
 * Service worker entry. It must sit at the base root: a worker's default (and,
 * without a Service-Worker-Allowed header, maximum) scope is its script's folder.
 */
export const SW_SOURCE = `import './${RUNTIME_NAME}/worker.js'\n`

/** "../" per folder between an HTML file (path relative to the root) and the root. */
const toRoot = (htmlPath: string) => '../'.repeat(Math.max(0, htmlPath.split('/').filter(Boolean).length - 1))

/** Script tag that loads the runtime, relative to the HTML file at `htmlPath`. */
export const registerTag = (htmlPath: string) =>
  `<script src="${toRoot(htmlPath)}${RUNTIME_NAME}/register.js" defer></script>`

/** Adds `snippet` (may be several lines) at the end of <head> if there is one, else at the start. */
export const injectIntoHead = (html: string, snippet: string) => {
  const match = /^([ \t]*)<\/head>/m.exec(html) ?? /<\/head>/.exec(html)
  if (!match) return `${snippet}\n${html}`
  const indent = match[1] ?? ''
  const lines = snippet.split('\n').map((line) => `${indent}  ${line}`)
  return `${html.slice(0, match.index)}${lines.join('\n')}\n${html.slice(match.index)}`
}
