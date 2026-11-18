#!/usr/bin/env node
// ts-code [root] [--port <n>]: serves the client folder `root` (default ".").
import { parseArgs } from 'node:util'
import { startServer } from './app.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: 'string', short: 'p' } },
})

await startServer({
  root: positionals[0] ?? '.',
  port: values.port ? Number(values.port) : undefined,
})
