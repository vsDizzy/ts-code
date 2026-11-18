// Static export of a client folder, in one of two modes:
//   ts: the files as they are plus the runtime; the browser transpiles via the SW.
//   js: .ts/.tsx transpiled here, an import map in each page; no runtime, no SW.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { RUNTIME_DIR, RUNTIME_NAME } from './env.ts'
import { gitignore } from './gitignore.ts'
import { injectIntoHead, registerTag, SW_FILE, SW_SOURCE } from './html.ts'

export type ExportMode = 'ts' | 'js'

export interface ExportOptions {
  /** Client folder. Default: ".". */
  root?: string
  /** Output folder; emptied first. Default: "<root>/dist". */
  out?: string
  /** Default: "ts". */
  mode?: ExportMode
}

const TS_FILE = /\.tsx?$/
const DTS_FILE = /\.d\.[cm]?ts$/
const isHtml = (path: string) => path.endsWith('.html')

/** Exports `root` to `out`; returns the output folder. */
export async function exportStatic({ root = '.', out, mode = 'ts' }: ExportOptions = {}) {
  root = resolve(root)
  out = resolve(out ?? join(root, 'dist'))
  const rootFromOut = relative(out, root)
  if (out === root || !(rootFromOut.startsWith('..') || isAbsolute(rootFromOut))) {
    throw new Error(`output folder ${out} must not be ${root} or contain it`)
  }

  const isIgnored = gitignore(root)
  const files = await listFiles(root, (path) => isIgnored(path) || join(root, path) === out)

  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })

  const write = async (path: string, data: string | Buffer) => {
    const file = join(out, path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, data)
  }

  if (mode === 'ts') {
    for (const path of files) {
      if (isHtml(path)) await write(path, injectIntoHead(await readFile(join(root, path), 'utf8'), registerTag(path)))
      else await write(path, await readFile(join(root, path)))
    }
    await cp(RUNTIME_DIR, join(out, RUNTIME_NAME), { recursive: true })
    await write(SW_FILE, SW_SOURCE)
    return out
  }

  const options = await compilerOptions(root)
  for (const path of files) {
    if (TS_FILE.test(path) && !DTS_FILE.test(path)) {
      const source = await readFile(join(root, path), 'utf8')
      await write(toJs(path), await rewriteImports(transpile(source, path, options), dirname(join(root, path)), options))
    } else if (isHtml(path)) {
      await write(path, await pageWithImportMap(root, path))
    } else {
      await write(path, await readFile(join(root, path)))
    }
  }
  return out
}

/** Files under `root` as "/"-separated relative paths; skipped folders aren't entered. */
async function listFiles(root: string, skip: (path: string) => boolean, dir = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name
    if (skip(path)) continue
    if (entry.isDirectory()) files.push(...(await listFiles(root, skip, path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

const toJs = (path: string) => path.replace(TS_FILE, '.js')

// --- js mode -------------------------------------------------------------------

/** Like the runtime (runtime/typescript.js), minus inline source maps. */
const DEFAULT_COMPILER_OPTIONS = { target: 'esnext', module: 'esnext' }

const diagnosticsHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: () => '/',
  getNewLine: () => '\n',
}

/** Options from `<root>/tsconfig.json` (one tsconfig for the whole export). */
async function compilerOptions(root: string): Promise<ts.CompilerOptions> {
  let config: { compilerOptions?: object } = {}
  const text = await readFile(join(root, 'tsconfig.json'), 'utf8').catch(() => null)
  if (text != null) {
    const parsed = ts.parseConfigFileTextToJson('tsconfig.json', text)
    if (parsed.error) throw new Error(ts.formatDiagnostics([parsed.error], diagnosticsHost))
    config = parsed.config ?? {}
  }
  const converted = ts.convertCompilerOptionsFromJson(
    { ...DEFAULT_COMPILER_OPTIONS, ...config.compilerOptions },
    '/',
    'tsconfig.json',
  )
  if (converted.errors.length) throw new Error(ts.formatDiagnostics(converted.errors, diagnosticsHost))
  return converted.options
}

function transpile(source: string, fileName: string, compilerOptions: ts.CompilerOptions) {
  // fileName's extension decides whether JSX is parsed (.tsx).
  const out = ts.transpileModule(source, { fileName, compilerOptions, reportDiagnostics: true })
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) throw new Error(ts.formatDiagnostics(errors, diagnosticsHost))
  return out.outputText
}

const exists = (file: string) => stat(file).then((s) => s.isFile(), () => false)

/**
 * Relative imports in transpiled `code` point at .js files: "./x.ts" -> "./x.js",
 * and, as the runtime resolves them, "./lib" -> "./lib.js" if lib.ts or lib.tsx
 * exists (unless allowImportingTsExtensions).
 */
async function rewriteImports(code: string, dir: string, options: ts.CompilerOptions) {
  const edits: { start: number; end: number; text: string }[] = []
  for (const ref of ts.preProcessFile(code, true, true).importedFiles) {
    const spec = ref.fileName
    // pos is the opening quote.
    const start = ref.pos + 1
    const end = start + spec.length
    if (!/^\.\.?\//.test(spec) || code.slice(start, end) !== spec) continue

    let text: string | undefined
    if (TS_FILE.test(spec)) text = toJs(spec)
    else if (/(^|\/)[^/.]+$/.test(spec) && !options.allowImportingTsExtensions) {
      for (const ext of ['.ts', '.tsx']) {
        if (await exists(join(dir, spec + ext))) {
          text = `${spec}.js`
          break
        }
      }
    }
    if (text) edits.push({ start, end, text })
  }
  for (const { start, end, text } of edits.reverse()) code = code.slice(0, start) + text + code.slice(end)
  return code
}

interface Manifest {
  name?: string
  main?: string
  dependencies?: Record<string, string>
}

/**
 * The page with the import map and entry script that runtime/register.js would
 * add at runtime, from the package.json next to it (unchanged if there is none).
 */
async function pageWithImportMap(root: string, path: string) {
  const html = await readFile(join(root, path), 'utf8')
  const text = await readFile(join(root, dirname(path), 'package.json'), 'utf8').catch(() => null)
  if (text == null) return html
  const pkg: Manifest = JSON.parse(text)

  // Same map as runtime/register.js, with main pointing at the .js output.
  const main = pkg.main && toJs(pkg.main.startsWith('.') ? pkg.main : `./${pkg.main}`)
  const imports: Record<string, string> = {}
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    imports[name] = `https://esm.sh/${name}@${version}`
    imports[`${name}/`] = `https://esm.sh/${name}@${version}/`
  }
  if (pkg.name) {
    if (main) imports[pkg.name] = main
    imports[`${pkg.name}/`] = './'
  }

  const map = JSON.stringify({ imports }, null, 2).replaceAll('\n', '\n  ')
  let snippet = `<script type="importmap">\n  ${map}\n</script>`
  if (main) snippet += `\n<script type="module" src="${main}"></script>`
  return injectIntoHead(html, snippet)
}
