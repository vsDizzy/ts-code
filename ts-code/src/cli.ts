#!/usr/bin/env node
// ts-code [root] [--base <url path>] [--port <n>]
//   Dev server for the client folder `root` (default ".") under `base` (default "/").
// ts-code export [root] [--out <dir>] [--mode ts|js]
//   Static export to `out` (default "<root>/dist"); see export.ts for the modes.
import { parseArgs } from 'node:util'
import { startServer } from './app.ts'
import { exportStatic, type ExportMode } from './export.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', short: 'b' },
    port: { type: 'string', short: 'p' },
    out: { type: 'string', short: 'o' },
    mode: { type: 'string', short: 'm' },
  },
})

if (positionals[0] === 'export') {
  const mode = (values.mode ?? 'ts') as ExportMode
  if (mode !== 'ts' && mode !== 'js') throw new Error(`--mode must be "ts" or "js", got "${mode}"`)
  try {
    const out = await exportStatic({ root: positionals[1], out: values.out, mode })
    console.info(`Exported to ${out} (${mode} mode)`)
  } catch (err) {
    console.error(`Export failed: ${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  }
} else {
  await startServer({
    root: positionals[0],
    base: values.base,
    port: values.port ? Number(values.port) : undefined,
  })
}
