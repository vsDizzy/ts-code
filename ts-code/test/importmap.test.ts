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
  test('one dependency, export: plain esm.sh URLs, own name -> main', () => {
    const map = importMap({ name: 'app', main: './app/main.tsx', dependencies: { lit: '3.3.0' } }, exportOptions)
    assert.deepEqual(map.imports, {
      lit: 'https://esm.sh/lit@3.3.0',
      'lit/': 'https://esm.sh/lit@3.3.0/',
      app: './app/main.js',
      'app/': './',
    })
  })

  test('one dependency, dev: ?dev on the module, &dev/ on the prefix', () => {
    const map = importMap({ name: 'app', dependencies: { lit: '3.3.0' } }, devOptions)
    assert.deepEqual(map.imports, {
      lit: 'https://esm.sh/lit@3.3.0?dev',
      'lit/': 'https://esm.sh/lit@3.3.0&dev/',
      app: 'http://localhost:3000/app/main.tsx',
      'app/': 'http://localhost:3000/',
    })
  })

  test('every dependency marks all the others external', () => {
    const pkg = { dependencies: { react: '19.3.1', 'react-dom': '19.3.1', '@scope/x': '1.0.0' } }
    assert.deepEqual(importMap(pkg, exportOptions).imports, {
      react: 'https://esm.sh/react@19.3.1?external=react-dom,@scope/x',
      'react/': 'https://esm.sh/react@19.3.1&external=react-dom,@scope%252Fx/',
      'react-dom': 'https://esm.sh/react-dom@19.3.1?external=react,@scope/x',
      'react-dom/': 'https://esm.sh/react-dom@19.3.1&external=react,@scope%252Fx/',
      '@scope/x': 'https://esm.sh/@scope/x@1.0.0?external=react,react-dom',
      '@scope/x/': 'https://esm.sh/@scope/x@1.0.0&external=react,react-dom/',
    })
    assert.equal(importMap(pkg, devOptions).imports['react-dom'], 'https://esm.sh/react-dom@19.3.1?external=react,@scope/x&dev')
    assert.equal(importMap(pkg, devOptions).imports['react-dom/'], 'https://esm.sh/react-dom@19.3.1&external=react,@scope%252Fx&dev/')
  })

  test('no name: no own entries; name without main: only the prefix', () => {
    assert.deepEqual(importMap({ main: './x.ts' }, exportOptions).imports, {})
    assert.deepEqual(importMap({ name: 'app' }, { pkgBase: './' }).imports, { 'app/': './' })
  })

  test('"?…" merges esm.sh options into the dependency URL', () => {
    const pkg = {
      dependencies: { typescript: '6.0.3', '@typescript-eslint/typescript-estree': '8.72.2' },
      'ts-code': { imports: { '@typescript-eslint/typescript-estree': '?bundle&target=es2022' } },
    }
    const name = '@typescript-eslint/typescript-estree'
    const base = `https://esm.sh/${name}@8.72.2`
    assert.equal(importMap(pkg, exportOptions).imports[name], `${base}?bundle&target=es2022&external=typescript`)
    assert.equal(importMap(pkg, exportOptions).imports[`${name}/`], `${base}&bundle&target=es2022&external=typescript/`)
    assert.equal(importMap(pkg, devOptions).imports[name], `${base}?bundle&target=es2022&external=typescript&dev`)
    assert.equal(importMap(pkg, devOptions).imports[`${name}/`], `${base}&bundle&target=es2022&external=typescript&dev/`)
    // Other dependencies are unaffected.
    assert.equal(importMap(pkg, exportOptions).imports.typescript, `https://esm.sh/typescript@6.0.3?external=${name}`)
  })

  test('user options override generated ones; an empty value removes one', () => {
    const deps = { a: '1.0.0', b: '2.0.0' }
    const own = importMap({ dependencies: deps, 'ts-code': { imports: { a: '?external=c' } } }, devOptions)
    assert.equal(own.imports.a, 'https://esm.sh/a@1.0.0?external=c&dev')
    const none = importMap({ dependencies: deps, 'ts-code': { imports: { a: '?external=' } } }, exportOptions)
    assert.equal(none.imports.a, 'https://esm.sh/a@1.0.0')
    assert.equal(none.imports['a/'], 'https://esm.sh/a@1.0.0/')
  })

  test('"?…" for a key that is not a dependency is an error', () => {
    assert.throws(() => importMap({ 'ts-code': { imports: { a: '?bundle' } } }, exportOptions), /needs "a" in dependencies/)
  })

  test('a bare name is an alias of another key, resolved to its final URL', () => {
    const pkg = {
      dependencies: { typescript: '6.0.3' },
      'ts-code': {
        imports: {
          tsl: 'typescript/lib/tsserverlibrary',
          'typescript/lib/tsserverlibrary': 'typescript',
          typescript: '?bundle',
        },
      },
    }
    const { imports } = importMap(pkg, devOptions)
    assert.equal(imports.typescript, 'https://esm.sh/typescript@6.0.3?bundle&dev')
    assert.equal(imports['typescript/lib/tsserverlibrary'], imports.typescript)
    assert.equal(imports.tsl, imports.typescript)
  })

  test('an alias can point at the own package or a URL entry', () => {
    const pkg = {
      name: 'app',
      'ts-code': { imports: { cdn: 'https://cdn.example/x.js', x: 'cdn', self: 'app/' } },
    }
    const { imports } = importMap(pkg, exportOptions)
    assert.equal(imports.x, 'https://cdn.example/x.js')
    assert.equal(imports.self, './')
  })

  test('unknown alias targets and cycles are errors', () => {
    assert.throws(() => importMap({ 'ts-code': { imports: { a: 'nope' } } }, exportOptions), /"nope" is not a URL/)
    assert.throws(() => importMap({ 'ts-code': { imports: { a: 'toString' } } }, exportOptions), /"toString" is not a URL/)
    assert.throws(() => importMap({ 'ts-code': { imports: { a: 'b', b: 'a' } } }, exportOptions), /alias cycle a -> b -> a/)
  })

  test('URLs are used verbatim, also for a dependency key', () => {
    const pkg = {
      dependencies: { a: '1.0.0', b: '1.0.0' },
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
    // The prefix entry stays generated, and b still treats a as external.
    assert.equal(imports['a/'], 'https://esm.sh/a@1.0.0&external=b&dev/')
    assert.equal(imports.b, 'https://esm.sh/b@1.0.0?external=a&dev')
    assert.equal(imports.local, './vendor/local.js')
    assert.equal(imports.root, '/abs.js')
    assert.equal(imports.up, '../up.js')
    assert.equal(imports.data, 'data:text/javascript,export default 1')
  })
})
