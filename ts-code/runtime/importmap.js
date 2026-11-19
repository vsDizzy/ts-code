// @ts-check
// The app's import map, built from its package.json. Shared by register.js (dev
// server and ts export, in the browser) and src/export.ts (js export, in Node),
// so it must stay plain ESM with no browser or Node APIs.
//
// - each `dependencies` entry -> https://esm.sh/<name>@<version>, plus `dev` on
//   the dev server;
// - `"ts-code": { "esm.sh": { <dependency>: "bundle&external=x" } }`: esm.sh
//   options for that dependency, passed as is. Every name in an `external=`
//   must be a key of the map: the browser resolves it through the map, which
//   is where its version comes from (dependencies), so no `deps=` is needed;
// - the package's own name -> `main`, `<name>/` -> files next to package.json;
// - `"ts-code": { "imports": { key: value } }` adds or overrides entries:
//     "https://…", "/…", "./…", "../…"   used as is;
//     "other-key"     alias: the URL another key of the map resolves to.

/**
 * @typedef {{
 *   name?: string,
 *   main?: string,
 *   dependencies?: Record<string, string>,
 *   'ts-code'?: { 'esm.sh'?: Record<string, string>, imports?: Record<string, string> },
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

/** Absolute URL or a URL relative to the page: used as is. */
const isUrl = (/** @type {string} */ value) => /^([a-z][a-z\d+.-]*:|\/|\.\.?\/)/i.test(value)

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
 * The query as path options for the `name/` prefix entry (`name@ver&opts/`,
 * since a prefix can't carry a query). esm.sh would split a value at "/"
 * (e.g. a scoped external), so it is written as %252F, which esm.sh decodes
 * back to "/".
 */
const pathOptions = (/** @type {string} */ query) =>
  query
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=')
      return eq < 0 ? part : part.slice(0, eq + 1) + part.slice(eq + 1).replaceAll('/', '%252F')
    })
    .join('&')

/**
 * @param {Manifest} pkg
 * @param {ImportMapOptions} options
 * @returns {{ imports: Record<string, string> }}
 */
export function importMap(pkg, { dev = false, main, pkgBase }) {
  const dependencies = pkg.dependencies ?? {}
  const esmSh = pkg['ts-code']?.['esm.sh'] ?? {}
  const extra = pkg['ts-code']?.imports ?? {}

  /** @type {Record<string, string>} */
  const options = {}
  for (const [name, value] of Object.entries(esmSh)) {
    if (!Object.hasOwn(dependencies, name)) {
      throw new Error(`"ts-code"["esm.sh"]["${name}"]: "${name}" is not in dependencies`)
    }
    options[name] = value.replace(/^\?/, '')
  }

  /** @type {Record<string, string>} */
  const imports = {}
  for (const [name, version] of Object.entries(dependencies)) {
    let query = options[name] ?? ''
    if (dev && !parseQuery(query).some(([key]) => key === 'dev')) query = query ? `${query}&dev` : 'dev'
    const base = `${ESM_SH}${name}@${version}`
    imports[name] = query ? `${base}?${query}` : base
    imports[`${name}/`] = query ? `${base}&${pathOptions(query)}/` : `${base}/`
  }
  if (pkg.name) {
    if (main) imports[pkg.name] = main
    imports[`${pkg.name}/`] = pkgBase
  }

  // URLs, then aliases (which may point at other aliases).
  /** @type {Record<string, string>} */
  const aliases = {}
  for (const [key, value] of Object.entries(extra)) {
    if (isUrl(value)) imports[key] = value
    else aliases[key] = value
  }
  /** @param {string} key @param {string[]} seen */
  const resolveAlias = (key, seen) => {
    if (seen.includes(key)) throw new Error(`"ts-code".imports: alias cycle ${[...seen, key].join(' -> ')}`)
    const target = aliases[key]
    if (Object.hasOwn(aliases, target)) return resolveAlias(target, [...seen, key])
    if (Object.hasOwn(imports, target)) return imports[target]
    throw new Error(`"ts-code".imports["${key}"]: "${target}" is neither a URL nor another key of the import map`)
  }
  for (const key of Object.keys(aliases)) imports[key] = resolveAlias(key, [])

  // An external import is left bare by esm.sh; without a map entry it fails in the browser.
  for (const [name, query] of Object.entries(options)) {
    for (const [key, value] of parseQuery(query)) {
      if (key !== 'external' || !value) continue
      for (const external of value.split(',')) {
        const dep = external.replace(/\/\*$/, '')
        if (Object.hasOwn(imports, dep) || Object.hasOwn(imports, `${dep}/`)) continue
        throw new Error(
          `"ts-code"["esm.sh"]["${name}"]: external "${dep}" is not in the import map; add it to dependencies`,
        )
      }
    }
  }

  return { imports }
}
