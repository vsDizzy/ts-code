# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A no-build TypeScript/TSX dev setup: the browser loads `.ts`/`.tsx` straight from `public/`, and a **service worker transpiles them in the browser** with the TypeScript JS API (loaded from esm.sh). The Node server only serves static files and drives live reload. There is no bundler, no build step, no test suite and no linter.

## Commands

Package manager is pnpm.

- `pnpm dev` — `node --watch src/app.ts`, serves `public/` on http://localhost:3000 (localhost only). Restarts on server `.ts` changes.
- `pnpm start` — same without `--watch`.

The server runs `.ts` directly via Node's built-in type stripping, so `src/` must use erasable-only TypeScript (no enums, namespaces, parameter properties) and import local files with the `.ts` extension. `.claude/launch.json` has a `dev` preview config (port 3000).

## Two separate halves

**Server — `src/`** (root `tsconfig.json`, includes only `src`)
- `app.ts`: h3 v2 app; `serveStatic` over `public/` with ETag-only caching (no Last-Modified, deliberately) and the live-reload script injected into every HTML response.
- `livereload.ts`: recursive `fs.watch` → debounced SSE `reload` event at `/@<pkg name>/livereload`; client script served at the same path + `.js` (`livereload.client.js`, read per request). Each server start has a new boot id sent as `hello`; the client reloads when it changes after a reconnect. Server `src/**/*.ts`, `.git` and `node_modules` are ignored by the watcher (node `--watch` handles server restarts).
- `env.ts`: `APP_PREFIX` = root `package.json` `name`; `RUNTIME_PATH` = `/@<name>`.

**Client — `public/`** (its own `package.json` + `tsconfig.json`)
- `public/package.json` is the *app's* manifest: `main` is the entry module, `dependencies` become an import map pointing at `https://esm.sh/<name>@<version>` (plus `<name>/` subpath entries). The package's own `name` maps to `main` and `<name>/` to files next to package.json. Nothing in `public/` is installed with pnpm.
- `public/tsconfig.json` is used both by the editor and, at runtime, by the service worker for transpile options.
- `public/@ts-code/` is the runtime (plain JS, JSDoc types):
  - `register.js` (included by `index.html`): registers `/sw.js` as a module worker, handles update/skip-waiting/claim (including hard reload), then posts the page's tsconfig text to the SW (`TSCONFIG` message, acked via MessageChannel), injects the import map, and dynamically imports `main`.
  - `worker.js`: SW lifecycle and a `HANDLERS` list (`{ name, match, handle, message?, caches }`). Only same-origin requests matching a handler are intercepted; SSE requests are never intercepted (would block SW activation). On activate, caches under the `ts-code/` prefix that no handler lists are deleted. **Bump `VERSION` when handler code changes** to drop cached output.
  - `typescript.js`: handler for `*.ts`/`*.tsx` and extensionless script imports (`./lib` → tries `lib.ts`, then `lib.tsx`; no `index.ts` resolution; disabled when `allowImportingTsExtensions` is true). The tsconfig is stored per page URL in Cache Storage (the SW can restart anytime). TypeScript is pinned to 6.x because 7.x has no JS API. Transpile errors return a 500 with the diagnostics.
  - `transform.js`: generic fetch → transform → cache, revalidated with `If-None-Match` against the source ETag; cache key includes a hash of compiler options + tsconfig text.
- `public/sw.js` only re-exports `@ts-code/worker.js`; it must stay at the site root so the SW scope covers the whole site.

## Gotchas

- The runtime folder name `public/@ts-code/` and the `ts-code` strings hardcoded in the client runtime (log tags, `APP_PREFIX` cache prefix in `worker.js`, `/@ts-code/register.js` in `index.html`) must match the root `package.json` `name`, since the server derives `/@<name>/livereload` from it. Renaming the package means updating all of these.
- Client app code is type-checked only by the editor; at runtime `transpileModule` does per-file transpilation (no type errors, `isolatedModules` semantics).
