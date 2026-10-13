import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { processTurn } from '../plugins/codex-step-risk/scripts/journal.mjs'

const script = fileURLToPath(new URL('../plugins/codex-step-risk/scripts/hook.mjs', import.meta.url))
const userScript = fileURLToPath(new URL('../plugins/codex-step-risk/scripts/user-hook.mjs', import.meta.url))
const common = { session_id: 'session-test', turn_id: 'turn-test', hook_event_name: 'PostToolUse', tool_name: 'Bash' }
const temp = () => mkdtempSync(join(tmpdir(), 'codex-step-risk-test-'))

function run(dataDir, input) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, PLUGIN_DATA: dataDir },
  })
}

function runAsync(dataDir, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, PLUGIN_DATA: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let error = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { error += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, output, error }))
    child.stdin.end(JSON.stringify(input))
  })
}

test('hook produces visible prediction and private metadata-only JSONL', () => {
  const dir = temp()
  try {
    const result = run(dir, {
      ...common, tool_use_id: 'tool-1',
      tool_input: { command: 'PRIVATE_PROMPT' },
      tool_response: { exit_code: 1, output: 'PRIVATE_OUTPUT' },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(JSON.parse(result.stdout).systemMessage, /uncalibrated/)
    assert.match(JSON.parse(result.stdout).systemMessage, /probability this step contributes to final task failure=13.5%/)
    assert.match(JSON.parse(result.stdout).systemMessage, /observed outcome=error/)
    const log = readFileSync(join(dir, 'logs', readdirSync(join(dir, 'logs'))[0]), 'utf8')
    assert.equal(log.trim().split('\n').length, 1)
    assert.ok(!log.includes('PRIVATE_'))
    assert.deepEqual(JSON.parse(log).evidenceCodes, ['tool_error'])
    assert.ok(JSON.parse(log).taskFailureRisk.value > 0.2)
    assert.equal(JSON.parse(log).taskFailureRisk.status, 'assumption_based_uncalibrated')
    assert.equal(JSON.parse(log).jointOriginFailure.value, null)
    assert.equal(JSON.parse(log).stepFailure.source, 'rules')
    assert.equal(JSON.parse(log).stepFailure.value, 0.135)
    const eventFolder = join(dir, 'events', readdirSync(join(dir, 'events'))[0])
    const journal = readFileSync(join(eventFolder, readdirSync(eventFolder)[0]), 'utf8')
    assert.ok(!journal.includes('PRIVATE_'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unknown tool response is stored in full in local logs without promoting it to success', () => {
  const dir = temp()
  try {
    const body = { output: 'full response\nsecond line', nested: { code: 'x' } }
    const result = run(dir, { ...common, tool_use_id: 'unknown-response',
      tool_input: { command: 'PRIVATE_COMMAND' }, tool_response: body })
    assert.equal(result.status, 0, result.stderr)
    const log = JSON.parse(readFileSync(join(dir, 'logs',
      readdirSync(join(dir, 'logs'))[0]), 'utf8'))
    assert.equal(log.outcome, 'unknown')
    assert.deepEqual(log.response, body)
    assert.equal(log.taskFailureRisk.value, 0.2)
    assert.ok(!JSON.stringify(log).includes('PRIVATE_COMMAND'))
    const eventFolder = join(dir, 'events', readdirSync(join(dir, 'events'))[0])
    const event = JSON.parse(readFileSync(join(eventFolder,
      readdirSync(eventFolder)[0]), 'utf8'))
    assert.deepEqual(event.observation.response, body)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('opted-in hook stores redacted action and response summaries for known outcomes', () => {
  const dir = temp()
  try {
    writeFileSync(join(dir, 'assessment-defaults.json'), JSON.stringify({ dataMode: 'context_summary' }))
    const result = run(dir, { ...common, tool_use_id: 'context-summary',
      tool_input: { command: 'run-tests --token CLI_SECRET', apiKey: 'INPUT_SECRET' },
      tool_response: { exit_code: 0, output: 'Tests passed', token: 'OUTPUT_SECRET' } })
    assert.equal(result.status, 0, result.stderr)
    const log = JSON.parse(readFileSync(join(dir, 'logs', readdirSync(join(dir, 'logs'))[0]), 'utf8'))
    assert.equal(log.outcome, 'success')
    assert.match(log.stepContext.actionSummary, /run-tests/)
    assert.match(log.stepContext.responseSummary, /Tests passed/)
    assert.ok(!JSON.stringify(log).includes('_SECRET'))
    assert.equal(log.response, undefined, 'known outcome should only preserve the redacted summary')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('user-level hook adapter supplies a private data directory without plugin variables', () => {
  const home = temp()
  try {
    const env = { ...process.env, CODEX_HOME: home }
    delete env.PLUGIN_DATA
    const result = spawnSync(process.execPath, [userScript], {
      input: JSON.stringify({ ...common, tool_use_id: 'user-hook-1',
        tool_response: { exit_code: 7, output: 'PRIVATE_OUTPUT' } }),
      encoding: 'utf8', env,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(JSON.parse(result.stdout).systemMessage, /event #1/)
    assert.match(JSON.parse(result.stdout).systemMessage, /observed outcome=error/)
    const logs = join(home, 'codex-step-risk', 'logs')
    const log = readFileSync(join(logs, readdirSync(logs)[0]), 'utf8')
    assert.deepEqual(JSON.parse(log).evidenceCodes, ['tool_error'])
    assert.ok(!log.includes('PRIVATE_OUTPUT'))
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('old duplicate IDs remain idempotent beyond the model recent-ID window', () => {
  const dir = temp()
  try {
    const event = id => ({
      kind: 'observation', sessionId: 's', turnId: 't',
      observation: { eventId: id, kind: 'tool', role: 'executor',
        actor: 'unknown_agent', toolName: 'Bash', outcome: 'success',
        evidenceCodes: ['no_hard_signal'] },
    })
    for (let n = 0; n < 270; n += 1) processTurn(dir, event('e' + n))
    assert.equal(processTurn(dir, event('e0')).snapshot, null)
    const summary = processTurn(dir, { kind: 'summary', sessionId: 's', turnId: 't' })
    assert.equal(summary.snapshot.ordinal, 270)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('malformed hook input exits cleanly without changing the host result', () => {
  const result = spawnSync(process.execPath, [script], { input: '{bad', encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout), {})
})

test('interleaved turns keep independent state and late older events', () => {
  const dir = temp()
  try {
    for (const [turn, id] of [['t1', 'a'], ['t2', 'b'], ['t1', 'c']]) {
      const result = run(dir, { ...common, turn_id: turn, tool_use_id: id,
        tool_response: { exit_code: 0 } })
      assert.equal(result.status, 0, result.stderr)
    }
    const t2 = run(dir, { ...common, turn_id: 't2', hook_event_name: 'Stop' })
    const t1 = run(dir, { ...common, turn_id: 't1', hook_event_name: 'Stop' })
    assert.match(JSON.parse(t2.stdout).systemMessage, /summary/)
    assert.match(JSON.parse(t1.stdout).systemMessage, /summary/)
    assert.equal(readdirSync(join(dir, 'state')).length, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('committed events recover when a derived state file is missing', () => {
  const dir = temp()
  try {
    for (const id of ['a', 'b']) {
      const result = run(dir, { ...common, tool_use_id: id,
        tool_response: { exit_code: 0 } })
      assert.equal(result.status, 0, result.stderr)
    }
    unlinkSync(join(dir, 'state', readdirSync(join(dir, 'state'))[0]))
    const summary = run(dir, { ...common, hook_event_name: 'Stop' })
    assert.equal(summary.status, 0, summary.stderr)
    assert.match(JSON.parse(summary.stdout).systemMessage, /summary/)
    const state = JSON.parse(readFileSync(join(dir, 'state', readdirSync(join(dir, 'state'))[0]), 'utf8'))
    assert.equal(state.ordinal, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('older state without a risk score rebuilds it from committed events', () => {
  const dir = temp()
  try {
    const first = run(dir, { ...common, tool_use_id: 'legacy-error',
      tool_response: { exit_code: 7 } })
    assert.equal(first.status, 0, first.stderr)
    const statePath = join(dir, 'state', readdirSync(join(dir, 'state'))[0])
    const state = JSON.parse(readFileSync(statePath, 'utf8'))
    delete state.riskScore
    writeFileSync(statePath, JSON.stringify(state))
    const second = run(dir, { ...common, tool_use_id: 'after-migration',
      tool_response: { output: 'no structured verdict' } })
    assert.equal(second.status, 0, second.stderr)
    const updated = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(updated.riskScore, 1)
    const logs = readFileSync(join(dir, 'logs', readdirSync(join(dir, 'logs'))[0]), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line))
    assert.equal(logs[1].taskFailureRisk.value, logs[0].taskFailureRisk.value)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('repeated hook event does not double-count; Stop returns summary', () => {
  const dir = temp()
  try {
    const input = { ...common, tool_use_id: 'tool-1', tool_response: { exit_code: 0 } }
    assert.equal(run(dir, input).status, 0)
    assert.equal(run(dir, input).status, 0)
    const log = readFileSync(join(dir, 'logs', readdirSync(join(dir, 'logs'))[0]), 'utf8')
    assert.equal(log.trim().split('\n').length, 1)
    const summary = run(dir, { ...common, hook_event_name: 'Stop' })
    assert.equal(summary.status, 0)
    assert.match(JSON.parse(summary.stdout).systemMessage, /summary/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('concurrent hook processes retain every distinct event', async () => {
  const dir = temp()
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, n) =>
      runAsync(dir, { ...common, tool_use_id: 'tool-' + n, tool_response: { exit_code: 0 } })))
    assert.ok(results.every(result => result.code === 0), JSON.stringify(results))
    const log = readFileSync(join(dir, 'logs', readdirSync(join(dir, 'logs'))[0]), 'utf8')
    assert.equal(log.trim().split('\n').length, 8)
    const state = JSON.parse(readFileSync(join(dir, 'state', readdirSync(join(dir, 'state'))[0]), 'utf8'))
    assert.equal(state.ordinal, 8)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
