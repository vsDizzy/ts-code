// Server-side constants from ts-code's package.json. The runtime (runtime/) hardcodes its own.
import { fileURLToPath } from 'node:url'
import pkg from '../package.json' with { type: 'json' }

/** package.json "name". */
export const APP_PREFIX = pkg.name

/** URL folder of the runtime; runtime/ of this package on disk. */
export const RUNTIME_PATH = `/@${APP_PREFIX}`

/** The runtime folder on disk. */
export const RUNTIME_DIR = fileURLToPath(new URL('../runtime/', import.meta.url))
