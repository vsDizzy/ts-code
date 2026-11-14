// Server-side constants from package.json. The client (public/@ts-code/) hardcodes its own.
import pkg from '../package.json' with { type: 'json' }

/** package.json "name". */
export const APP_PREFIX = pkg.name

/** URL folder of the runtime; public/@<name>/ on disk. */
export const RUNTIME_PATH = `/@${APP_PREFIX}`
