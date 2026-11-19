// @ts-check
// The app's import map, built from its package.json. Shared by register.js (dev
// server and ts export, in the browser) and src/export.ts (js export, in Node),
// so it must stay plain ESM with no browser or Node APIs.
//
// - each `dependencies` entry -> esm.sh, with every other dependency marked
//   external so shared packages resolve through this map to one instance;
// - the package's own name -> `main`, `<name>/` -> files next to package.json;
// - `"ts-code": { "imports": { key: value } }` adds or overrides entries:
//     "?bundle"       extra esm.sh options for the dependency `key`;
//     "other-key"     alias: the URL another key of the map resolves to;
//     "https://…", "/…", "./…", "../…"   used as is.

/**
 * @typedef {{
 *   name?: string,
 *   main?: string,
 *   dependencies?: Record<string, string>,
 *   'ts-code'?: { imports?: Record<string, string> },
 * }} Manifest
 * @typedef {{
 *   dev?: boolean,
 *   main?: string,
 *   pkgBase: string,
 * }} ImportMapOptions
 *   dev: esm.sh development builds. main: URL of the entry module (the own
 *   name maps to it; omitted if unset). pkgBase: URL of the folder holding
 *   package.json, ending in "/".
 */

export const ESM_SH = 'https://esm.sh/'

/** "a=1&b" -> [["a", "1"], ["b", null]] */
const parseQuery = (/** @type {string} */ query) =>
  query
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=')
      return /** @type {[string, string | null]} */ (eq < 0 ? [part, null] : [part.slice(0, eq), part.slice(eq + 1)])
    })

/**
 * esm.sh options, as a query for the module itself and as path options for the
 * `name/` prefix entry (`name@ver&opts/`, since a prefix can't carry a query).
 * In the path form esm.sh would split a value at "/" (e.g. a scoped external),
 * so it is written as %252F, which esm.sh decodes back to "/".
 * @param {[string, string | null][]} params
 */
const formatOptions = (params) => {
  const parts = (/** @type {(v: string) => string} */ encode) =>
    params.map(([key, value]) => (value == null ? key : `${key}=${encode(value)}`)).join('&')
  return { query: parts((v) => v), path: parts((v) => v.replaceAll('/', '%252F')) }
}

/** Absolute URL or a URL relative to the page: used as is. */
const isUrl = (/** @type {string} */ value) => /^([a-z][a-z\d+.-]*:|\/|\.\.?\/)/i.test(value)

/**
 * @param {Manifest} pkg
 * @param {ImportMapOptions} options
 * @returns {{ imports: Record<string, string> }}
 */
export function importMap(pkg, { dev = false, main, pkgBase }) {
  const dependencies = pkg.dependencies ?? {}
  const names = Object.keys(dependencies)
  const extra = pkg['ts-code']?.imports ?? {}

  // Options added per dependency by "?…" entries.
  /** @type {Record<string, [string, string | null][]>} */
  const userOptions = {}
  for (const [key, value] of Object.entries(extra)) {
    if (!value.startsWith('?')) continue
    if (!Object.hasOwn(dependencies, key)) throw new Error(`"ts-code".imports["${key}"]: "${value}" needs "${key}" in dependencies`)
    userOptions[key] = parseQuery(value.slice(1))
  }

  /** @type {Record<string, string>} */
  const imports = {}
  for (const name of names) {
    // The user's options win over generated ones of the same name; an empty
    // value ("external=") removes that option.
    const user = userOptions[name] ?? []
    const given = new Set(user.map(([key]) => key))
    const external = names.filter((other) => other !== name).join(',')
    /** @type {[string, string | null][]} */
    const params = [...user.filter(([, value]) => value !== '')]
    if (external && !given.has('external')) params.push(['external', external])
    if (dev && !given.has('dev')) params.push(['dev', null])

    const { query, path } = formatOptions(params)
    const base = `${ESM_SH}${name}@${dependencies[name]}`
    imports[name] = query ? `${base}?${query}` : base
    imports[`${name}/`] = path ? `${base}&${path}/` : `${base}/`
  }
  if (pkg.name) {
    if (main) imports[pkg.name] = main
    imports[`${pkg.name}/`] = pkgBase
  }

  // URLs, then aliases (which may point at other aliases).
  /** @type {Record<string, string>} */
  const aliases = {}
  for (const [key, value] of Object.entries(extra)) {
    if (value.startsWith('?')) continue
    if (isUrl(value)) imports[key] = value
    else aliases[key] = value
  }
  /** @param {string} key @param {string[]} seen */
  const resolveAlias = (key, seen) => {
    if (seen.includes(key)) throw new Error(`"ts-code".imports: alias cycle ${[...seen, key].join(' -> ')}`)
    const target = aliases[key]
    if (Object.hasOwn(aliases, target)) return resolveAlias(target, [...seen, key])
    if (Object.hasOwn(imports, target)) return imports[target]
    throw new Error(`"ts-code".imports["${key}"]: "${target}" is not a URL, "?options" or another key of the import map`)
  }
  for (const key of Object.keys(aliases)) imports[key] = resolveAlias(key, [])

  return { imports }
}
