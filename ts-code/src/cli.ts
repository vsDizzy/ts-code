#!/usr/bin/env node
// ts-code [root] [--base <url path>] [--port <n>]: serves the client folder `root`
// (default ".") under `base` (default "/").
import { parseArgs } from 'node:util'
import { startServer } from './app.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', short: 'b' },
    port: { type: 'string', short: 'p' },
  },
})

await startServer({
  root: positionals[0],
  base: values.base,
  port: values.port ? Number(values.port) : undefined,
})
