// Server-side constants from ts-code's package.json. The runtime (runtime/) hardcodes its own.
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }

export const APP_PREFIX = pkg.name

/** URL folder of the runtime, relative to the base URL: `<base>@<name>/`. */
export const RUNTIME_NAME = `@${APP_PREFIX}`

export const RUNTIME_DIR = fileURLToPath(new URL('../runtime/', import.meta.url))
