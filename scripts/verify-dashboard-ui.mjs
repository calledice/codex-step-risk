// Local-only UI fixture: never invokes a model or reads user event logs.
// Run manually, then open http://127.0.0.1:43149/. Stops after 3 minutes.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDashboard } from '../plugins/codex-step-risk/scripts/dashboard-server.mjs'
import { LunaError } from '../plugins/codex-step-risk/scripts/luna-explain.mjs'

const dataDir = mkdtempSync(join(tmpdir(), 'step-risk-v04-ui-'))
mkdirSync(join(dataDir, 'logs'))
const common = { sessionId: 'isolated-ui-test', turnId: 'fixture-turn', kind: 'tool', role: 'executor' }
const events = [
  { ...common, ordinal: 1, toolName: 'apply_patch', operation: 'action', outcome: 'success',
    outcomeEvidence: [{ type: 'success_flag', field: 'ok', value: true }] },
  { ...common, ordinal: 2, toolName: 'apply_patch', operation: 'action', outcome: 'error',
    outcomeEvidence: [{ type: 'exit_code', field: 'exit_code', value: 1 }] },
  { ...common, ordinal: 3, toolName: 'Bash', outcome: 'unknown',
    outcomeEvidence: [{ type: 'response_text_only' }], response: 'UI fixture only: no structured verdict' },
]
writeFileSync(join(dataDir, 'logs', 'fixture.jsonl'), events.map(JSON.stringify).join('\n') + '\n')
const server = await startDashboard({ dataDir, port: 43149,
  lunaConnection: { provider: 'isolated-test', host: 'no-network.invalid',
    apiKey: 'unused-fixture-value', apiUrl: 'https://no-network.invalid/responses' },
  assess: async () => { throw new LunaError('network_error') },
})
console.log('Isolated UI fixture: http://127.0.0.1:43149/ (no outbound requests)')
setTimeout(() => server.close(), 180000)
