# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A no-build TypeScript/TSX dev setup: the browser loads `.ts`/`.tsx` straight from the client folder, and a **service worker transpiles them in the browser** with the TypeScript JS API (loaded from esm.sh). The Node server only serves static files and drives live reload. A static export can ship the same setup, or pre-transpiled JS with no worker. There is no bundler, no test suite and no linter.

pnpm monorepo (`pnpm-workspace.yaml`):
- `ts-code/` — the tool: server and exporter (`src/`) plus the browser runtime (`runtime/`), `bin: ts-code`.
- `sample-app/` — an example client; `devDependencies: { "ts-code": "workspace:*" }`. Scripts: `dev` = `ts-code .`, `export` / `export:js` write `dist/`.

## Commands

- `pnpm dev` (root) — `node --watch ts-code/src/cli.ts sample-app`: restarts on server `.ts` changes. Use this when working on the server.
- `pnpm start` (root) — `pnpm --filter sample-app dev`, i.e. the `ts-code .` bin as an app would run it.
- `ts-code [root] [--base path] [--port n]` — serves `root` (default `.`) under `base` (default `/`; `app`, `/app` and `app/` all mean `/app/`) on http://localhost:3000 (localhost only).
- `ts-code export [root] [--out dir] [--mode ts|js]` — static export to `out` (default `<root>/dist`). The output folder is emptied first; it must not be `root` or contain it.
- `pnpm exec tsc -p ts-code` — type-checks the server (`typescript` is a dependency of ts-code).

`.claude/launch.json` has `dev` and `sample-app` preview configs (both port 3000).

The server runs `.ts` directly via Node's built-in type stripping, so `ts-code/src/` must use erasable-only TypeScript (no enums, namespaces, parameter properties) and import local files with the `.ts` extension. Node refuses to strip types under `node_modules`; it works here only because the workspace symlink resolves to the real `ts-code/` path. Publishing the package would need compiled `.js`.

## Server — `ts-code/src/` (`ts-code/tsconfig.json`)

- `cli.ts`: bin entry. `export` as the first argument runs `exportStatic`, anything else runs `startServer`.
- `app.ts`: `startServer({ root, base, port })`, h3 v2. One `serveStatic` with ETag-only caching (no Last-Modified, deliberately); HTML ETags also carry a per-start token, since the injected tags can change with server code. Every HTML response gets the live-reload script, then the runtime script (path relative to the page); the order matters, see React Fast Refresh. Request path → file:
  - `<base>@ts-code.sw.js` → generated SW entry (`SW_SOURCE`);
  - `<base>@ts-code/*` → `ts-code/runtime/`;
  - the rest of `<base>*` → `root`, unless `.gitignore` ignores it (404);
  - paths outside `base`, or escaping either folder, give 404.

  When `base` isn't `/`, `/` and `base` without its trailing slash redirect to `base`, since the page must be inside the worker's scope.
- `html.ts`: shared by server and export. `SW_FILE` / `SW_SOURCE` define the worker entry, a one-line `import './@ts-code/worker.js'`. It sits at the base root so its default scope is the base and no `Service-Worker-Allowed` header is needed, which matters because static hosts can't set one. Also `registerTag(htmlPath)` (relative `…/@ts-code/register.js`) and `injectIntoHead`.
- `export.ts`: `exportStatic({ root, out, mode })`. It copies the files `.gitignore` doesn't ignore, skipping `out` itself. The result doesn't depend on the base URL.
  - `ts` mode: files unchanged, HTML gets the register tag, plus `@ts-code/` (the runtime) and `@ts-code.sw.js`.
  - `js` mode: no runtime, no SW. `.ts`/`.tsx` (not `.d.ts`) are transpiled with `typescript` 6.0.3 and the root `tsconfig.json` (one tsconfig for all files, no source maps) to `.js`. Relative imports are rewritten: `./x.ts` → `./x.js`, and extensionless `./lib` → `./lib.js` when `lib.ts`/`lib.tsx` exists, unless `allowImportingTsExtensions`. `./lib.js` is kept, since it already names the output. The export fails if two sources would map to one output, e.g. `lib.ts` + `lib.js` or `lib.ts` + `lib.tsx`. Each HTML file with a `package.json` next to it gets the import map `register.js` would build plus `<script type="module" src="<main>.js">`. Files only the export reads are not copied: the root `tsconfig.json`, `package.json` files next to pages, and `.d.ts` files.
- `gitignore.ts`: `<root>/.gitignore` as a predicate, used by the HTTP server, the watcher and the export. `.git` and `.gitignore` are always ignored. Matching uses the `ignore` package (full gitignore syntax, as in ESLint/Prettier). Callers don't know whether a path is a folder, so each path is also checked with a trailing `/`. Nested `.gitignore` files are not read. With an `onChange` callback, a non-recursive watch on `root` re-reads the rules when `.gitignore` changes, then calls `onChange`. It watches the folder because rename-on-save would end a watch on the file. `app.ts` uses `onChange` to reload the page.
- `livereload.ts`: recursive `fs.watch` of the client `root` only (not the runtime, not the server) → debounced SSE `reload` event at `<base>@ts-code/livereload` carrying the changed paths (relative to `root`). Paths that are folders or no longer exist are dropped, since atomic saves report a temp file and the folder; so deleting a file alone triggers nothing. The client script is served at the same path + `.js` (`livereload.client.js`, read per request). Each server start has a new boot id sent as `hello`; the client reloads when it changes after a reconnect. Returns `{ tag, reload(file) }`.
- `env.ts`: `APP_PREFIX` = `ts-code/package.json` `name`; `RUNTIME_NAME` = `@<name>` (URL folder under `base`); `RUNTIME_DIR` = `ts-code/runtime/`.

## Client — e.g. `sample-app/`

- Its `package.json` is the app's manifest: `main` is the entry module, `dependencies` become an import map pointing at `https://esm.sh/<name>@<version>` (plus `<name>/` subpath entries). The package's own `name` maps to `main` and `<name>/` to files next to package.json. pnpm installs those dependencies too (and `@types/*` dev deps for the editor), but the browser never uses `node_modules`.
- Its `tsconfig.json` is used by the editor, at runtime by the service worker, and by the js export for transpile options.
- `index.html` has no ts-code script tag; the server and the export add it.
- Its `.gitignore` must list `node_modules/` and `dist/`, or they get served, watched and exported.

## Runtime — `ts-code/runtime/` (plain JS, JSDoc types, served at `<base>@ts-code/`)

- `register.js`: registers `../@ts-code.sw.js` (resolved from its own `currentScript.src`, so the default scope is the base) as a module worker. It handles update/skip-waiting/claim (including hard reload), posts the page's tsconfig text to the SW (`TSCONFIG` message, acked via MessageChannel), injects the import map, and dynamically imports `main`.
- `worker.js`: SW lifecycle and a `HANDLERS` list (`{ name, match, handle, message?, caches }`). Only same-origin requests matching a handler are intercepted. SSE requests are never intercepted, since that would block SW activation. On activate, caches under the `ts-code/` prefix that no handler lists are deleted. **Bump `VERSION` when handler code changes** to drop cached output.
- `typescript.js`: handler for these requests:
  - `*.ts`/`*.tsx`;
  - extensionless script imports: `./lib` → tries `lib.ts`, then `lib.tsx`. No `index.ts` resolution; disabled when `allowImportingTsExtensions` is true;
  - `.js` script imports, the TypeScript convention: `./lib.js` is fetched as is, and only after a 404 tries `lib.ts`, then `lib.tsx`. The tsconfig is stored per page URL in Cache Storage, because the SW can restart anytime. TypeScript is pinned to 6.x because 7.x has no JS API. Transpile errors return a 500 with the diagnostics.
- `transform.js`: generic fetch → transform → cache, revalidated with `If-None-Match` against the source ETag. The cache key includes a hash of compiler options + tsconfig text + the refresh flag. The query string is dropped for `.ts`/`.tsx`, so `App.tsx?t=…` shares the cache entry of `App.tsx`.

## React Fast Refresh (dev server only)

Generic, opt-in by the app: on when its `package.json` `dependencies` include `react`.
- `livereload.client.js` (loaded before `register.js`) defines `window.__tsCodeHot`. Its presence means "dev server": `register.js` then maps dependencies to esm.sh development builds (`https://esm.sh/<name>@<version>&dev`, `&dev` in the path so subpaths get it too), which refresh needs. `__tsCodeHot.setup(pkg)` loads `react-refresh/runtime` from esm.sh and calls `injectIntoGlobalHook` before `main` (and so react-dom) loads.
- `register.js` sends `refresh: true` with `TSCONFIG`; the SW stores `{ configText, refresh }` per page. With it, `typescript.js` runs the `react-refresh-typescript` transformer (its `dist/core.js`, given our `ts`, no hash function) and appends hoisted `$RefreshReg$`/`$RefreshSig$` functions that forward to `__tsCodeHot` with ids `<file path> <name>`, plus `__tsCodeHot.loaded(file, import.meta.url)`. The footer goes before the inline source map comment.
- On a `reload` event the client tries a hot update: every changed file must be a `.ts`/`.tsx` this page loaded; each is re-imported as `<url>?t=<now>`, and every module must export at least one value and only components (`isLikelyComponentType`), because importers keep the old module. Then `performReactRefresh()`. Anything else is a full reload. A failed re-import (e.g. syntax error) is logged and the page kept.
- Neither export uses any of this: there is no `__tsCodeHot`, so `ts` mode gets production builds and no transform.

## Gotchas

- These `ts-code` strings are hardcoded in the runtime and must match `ts-code/package.json` `name`, since the server derives `@<name>/` and `@<name>.sw.js` from it: log tags, the `APP_PREFIX` cache prefix in `worker.js`, and `../@ts-code.sw.js` in `register.js`. Renaming the package means updating all of these.
- Keep the js export in step with the runtime: the import map and the extensionless-import resolution are implemented twice (`register.js` / `typescript.js` and `export.ts`), as are the default compiler options. The `&dev` import map variant is dev-server only.
- Runtime edits don't trigger live reload; reload the page yourself, and bump `VERSION` in `worker.js` if handler code changed.
- Client app code is type-checked only by the editor. At runtime and in the js export, `transpileModule` transpiles one file at a time, so there are no type errors and `isolatedModules` semantics apply.
