# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A no-build TypeScript/TSX dev setup: the browser loads `.ts`/`.tsx` straight from the client folder, and a **service worker transpiles them in the browser** with the TypeScript JS API (loaded from esm.sh). The Node server only serves static files and drives live reload. There is no bundler, no build step, no test suite and no linter.

pnpm monorepo (`pnpm-workspace.yaml`):
- `ts-code/` — the tool: server (`src/`) + browser runtime (`runtime/`), `bin: ts-code`.
- `sample-app/` — an example client; `devDependencies: { "ts-code": "workspace:*" }`, `dev` script = `ts-code .`.

## Commands

- `pnpm dev` (root) — `node --watch ts-code/src/cli.ts sample-app`: restarts on server `.ts` changes. Use this when working on the server.
- `pnpm start` (root) — `pnpm --filter sample-app dev`, i.e. the `ts-code .` bin as an app would run it.
- `ts-code [root] [--port n]` — serves `root` (default `.`) on http://localhost:3000 (localhost only).

`.claude/launch.json` has `dev` and `sample-app` preview configs (both port 3000).

The server runs `.ts` directly via Node's built-in type stripping, so `ts-code/src/` must use erasable-only TypeScript (no enums, namespaces, parameter properties) and import local files with the `.ts` extension. Node refuses to strip types under `node_modules`; it works here only because the workspace symlink resolves to the real `ts-code/` path. Publishing the package would need compiled `.js`.

## Server — `ts-code/src/` (`ts-code/tsconfig.json`)

- `cli.ts`: bin entry, parses args, calls `startServer`.
- `app.ts`: `startServer({ root, port })`, h3 v2. One `serveStatic` with ETag-only caching (no Last-Modified, deliberately) and the live-reload script injected into every HTML response. Request path → file: `/@ts-code/*` → `ts-code/runtime/`, anything else → `root` unless `.gitignore` ignores it (404). Paths escaping either folder give 404. Adds `Service-Worker-Allowed: /` to `/@ts-code/worker.js`.
- `gitignore.ts`: `<root>/.gitignore` as a predicate, used by both the HTTP server and the watcher. `.git` and `.gitignore` are always ignored. Matching uses the `ignore` package (full gitignore syntax, as in ESLint/Prettier). Callers don't know whether a path is a folder, so each path is also checked with a trailing `/`. Nested `.gitignore` files are not read. A non-recursive watch on `root` re-reads the rules when `.gitignore` changes; it watches the folder because rename-on-save would end a watch on the file. Rule changes don't reload the page.
- `livereload.ts`: recursive `fs.watch` of the client `root` only (not the runtime, not the server) → debounced SSE `reload` event at `/@ts-code/livereload`. The client script is served at the same path + `.js` (`livereload.client.js`, read per request). Each server start has a new boot id sent as `hello`; the client reloads when it changes after a reconnect.
- `env.ts`: `APP_PREFIX` = `ts-code/package.json` `name`; `RUNTIME_PATH` = `/@<name>`; `RUNTIME_DIR` = `ts-code/runtime/`.

## Client — e.g. `sample-app/`

- Its `package.json` is the app's manifest: `main` is the entry module, `dependencies` become an import map pointing at `https://esm.sh/<name>@<version>` (plus `<name>/` subpath entries). The package's own `name` maps to `main` and `<name>/` to files next to package.json. pnpm installs those dependencies too, but the browser never uses `node_modules`.
- Its `tsconfig.json` is used both by the editor and, at runtime, by the service worker for transpile options.
- `index.html` includes `<script src="/@ts-code/register.js" defer>`.
- Its `.gitignore` must list `node_modules/`, or it gets served.

## Runtime — `ts-code/runtime/` (plain JS, JSDoc types, served at `/@ts-code/`)

- `register.js`: registers `worker.js` (resolved from its own `currentScript.src`) as a module worker with `scope: '/'`, which needs the server's `Service-Worker-Allowed` header. It handles update/skip-waiting/claim (including hard reload), posts the page's tsconfig text to the SW (`TSCONFIG` message, acked via MessageChannel), injects the import map, and dynamically imports `main`.
- `worker.js`: SW lifecycle and a `HANDLERS` list (`{ name, match, handle, message?, caches }`). Only same-origin requests matching a handler are intercepted. SSE requests are never intercepted, since that would block SW activation. On activate, caches under the `ts-code/` prefix that no handler lists are deleted. **Bump `VERSION` when handler code changes** to drop cached output.
- `typescript.js`: handler for `*.ts`/`*.tsx` and extensionless script imports (`./lib` → tries `lib.ts`, then `lib.tsx`; no `index.ts` resolution; disabled when `allowImportingTsExtensions` is true). The tsconfig is stored per page URL in Cache Storage, because the SW can restart anytime. TypeScript is pinned to 6.x because 7.x has no JS API. Transpile errors return a 500 with the diagnostics.
- `transform.js`: generic fetch → transform → cache, revalidated with `If-None-Match` against the source ETag. The cache key includes a hash of compiler options + tsconfig text.

## Gotchas

- These `ts-code` strings are hardcoded in the runtime and must match `ts-code/package.json` `name`, since the server derives `/@<name>/` from it: log tags, the `APP_PREFIX` cache prefix in `worker.js`, and `/@ts-code/register.js` in each app's `index.html`. Renaming the package means updating all of these.
- Runtime edits don't trigger live reload; reload the page yourself, and bump `VERSION` in `worker.js` if handler code changed.
- Client app code is type-checked only by the editor. At runtime `transpileModule` transpiles one file at a time, so there are no type errors and `isolatedModules` semantics apply.
