import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// User-level hooks do not receive the plugin-specific writable directory.
const codexHome = process.env.CODEX_HOME
const home = codexHome && isAbsolute(codexHome)
  ? codexHome : join(homedir(), '.codex')
process.env.PLUGIN_DATA = join(home, 'codex-step-risk')
await import('./hook.mjs')
