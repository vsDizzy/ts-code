import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { importMap } from '../runtime/importmap.js'

const exportOptions = { main: './app/main.js', pkgBase: './' }
const devOptions = {
  dev: true,
  main: 'http://localhost:3000/app/main.tsx',
  pkgBase: 'http://localhost:3000/',
}

describe('importMap', () => {
  test('export: plain esm.sh URLs, no options; own name -> main', () => {
    const pkg = { name: 'app', main: './app/main.tsx', dependencies: { react: '19.3.1', 'react-dom': '19.3.1' } }
    assert.deepEqual(importMap(pkg, exportOptions).imports, {
      react: 'https://esm.sh/react@19.3.1',
      'react/': 'https://esm.sh/react@19.3.1/',
      'react-dom': 'https://esm.sh/react-dom@19.3.1',
      'react-dom/': 'https://esm.sh/react-dom@19.3.1/',
      app: './app/main.js',
      'app/': './',
    })
  })

  test('dev: ?dev on the module, &dev/ on the prefix', () => {
    const map = importMap({ name: 'app', dependencies: { lit: '3.3.0' } }, devOptions)
    assert.deepEqual(map.imports, {
      lit: 'https://esm.sh/lit@3.3.0?dev',
      'lit/': 'https://esm.sh/lit@3.3.0&dev/',
      app: 'http://localhost:3000/app/main.tsx',
      'app/': 'http://localhost:3000/',
    })
  })

  test('no name: no own entries; name without main: only the prefix', () => {
    assert.deepEqual(importMap({ main: './x.ts' }, exportOptions).imports, {})
    assert.deepEqual(importMap({ name: 'app' }, { pkgBase: './' }).imports, { 'app/': './' })
  })

  test('"esm.sh" options are passed as is (js-meta case)', () => {
    const name = '@typescript-eslint/typescript-estree'
    const pkg = {
      dependencies: { typescript: '6.0.3', [name]: '8.72.2' },
      'ts-code': { 'esm.sh': { [name]: 'bundle&external=typescript' } },
    }
    const base = `https://esm.sh/${name}@8.72.2`
    const exp = importMap(pkg, exportOptions).imports
    assert.equal(exp[name], `${base}?bundle&external=typescript`)
    assert.equal(exp[`${name}/`], `${base}&bundle&external=typescript/`)
    assert.equal(exp.typescript, 'https://esm.sh/typescript@6.0.3')
    const dev = importMap(pkg, devOptions).imports
    assert.equal(dev[name], `${base}?bundle&external=typescript&dev`)
    assert.equal(dev[`${name}/`], `${base}&bundle&external=typescript&dev/`)
    assert.equal(dev.typescript, 'https://esm.sh/typescript@6.0.3?dev')
  })

  test('a leading "?" is stripped; an explicit dev is not repeated', () => {
    const pkg = { dependencies: { a: '1.0.0' }, 'ts-code': { 'esm.sh': { a: '?dev&target=es2022' } } }
    assert.equal(importMap(pkg, devOptions).imports.a, 'https://esm.sh/a@1.0.0?dev&target=es2022')
    assert.equal(importMap(pkg, exportOptions).imports.a, 'https://esm.sh/a@1.0.0?dev&target=es2022')
  })

  test('"/" in a value is %252F in the prefix (path) form only', () => {
    const pkg = {
      dependencies: { a: '1.0.0', '@scope/x': '2.0.0' },
      'ts-code': { 'esm.sh': { a: 'external=@scope/x' } },
    }
    const { imports } = importMap(pkg, devOptions)
    assert.equal(imports.a, 'https://esm.sh/a@1.0.0?external=@scope/x&dev')
    assert.equal(imports['a/'], 'https://esm.sh/a@1.0.0&external=@scope%252Fx&dev/')
  })

  test('"esm.sh" for a key that is not a dependency is an error', () => {
    assert.throws(() => importMap({ 'ts-code': { 'esm.sh': { a: 'bundle' } } }, exportOptions), /"a" is not in dependencies/)
  })

  test('every external must be a key of the map', () => {
    const deps = { a: '1.0.0', b: '1.0.0' }
    const withExternal = (value: string, imports = {}) => ({
      dependencies: deps,
      'ts-code': { 'esm.sh': { a: value }, imports },
    })
    assert.throws(() => importMap(withExternal('bundle&external=b,react'), exportOptions), /external "react" is not in the import map/)
    assert.doesNotThrow(() => importMap(withExternal('external=b,b/*'), exportOptions))
    // An "imports" entry counts too.
    assert.doesNotThrow(() => importMap(withExternal('external=c', { c: 'https://cdn.example/c.js' }), exportOptions))
  })

  test('a bare name is an alias of another key, resolved to its final URL', () => {
    const pkg = {
      dependencies: { typescript: '6.0.3' },
      'ts-code': { imports: { tsl: 'typescript/lib/tsserverlibrary', 'typescript/lib/tsserverlibrary': 'typescript' } },
    }
    const { imports } = importMap(pkg, devOptions)
    assert.equal(imports.typescript, 'https://esm.sh/typescript@6.0.3?dev')
    assert.equal(imports['typescript/lib/tsserverlibrary'], imports.typescript)
    assert.equal(imports.tsl, imports.typescript)
  })

  test('an alias can point at the own package or a URL entry', () => {
    const pkg = { name: 'app', 'ts-code': { imports: { cdn: 'https://cdn.example/x.js', x: 'cdn', self: 'app/' } } }
    const { imports } = importMap(pkg, exportOptions)
    assert.equal(imports.x, 'https://cdn.example/x.js')
    assert.equal(imports.self, './')
  })

  test('unknown alias targets (including "?opts") and cycles are errors', () => {
    const bad = (imports: Record<string, string>) => () => importMap({ 'ts-code': { imports } }, exportOptions)
    assert.throws(bad({ a: 'nope' }), /"nope" is neither a URL nor another key/)
    assert.throws(bad({ a: 'toString' }), /"toString" is neither a URL nor another key/)
    assert.throws(bad({ a: '?bundle' }), /"\?bundle" is neither a URL nor another key/)
    assert.throws(bad({ a: 'b', b: 'a' }), /alias cycle a -> b -> a/)
  })

  test('URLs are used verbatim, also for a dependency key', () => {
    const pkg = {
      dependencies: { a: '1.0.0' },
      'ts-code': {
        imports: {
          a: 'https://cdn.example/a@1?x=1',
          local: './vendor/local.js',
          root: '/abs.js',
          up: '../up.js',
          data: 'data:text/javascript,export default 1',
        },
      },
    }
    const { imports } = importMap(pkg, devOptions)
    assert.equal(imports.a, 'https://cdn.example/a@1?x=1')
    // The prefix entry stays generated.
    assert.equal(imports['a/'], 'https://esm.sh/a@1.0.0&dev/')
    assert.equal(imports.local, './vendor/local.js')
    assert.equal(imports.root, '/abs.js')
    assert.equal(imports.up, '../up.js')
    assert.equal(imports.data, 'data:text/javascript,export default 1')
  })
})
