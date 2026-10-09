import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../plugins/codex-step-risk/scripts/hook.mjs', import.meta.url))
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
    const log = readFileSync(join(dir, 'logs', readdirSync(join(dir, 'logs'))[0]), 'utf8')
    assert.equal(log.trim().split('\n').length, 1)
    assert.ok(!log.includes('PRIVATE_'))
    assert.deepEqual(JSON.parse(log).evidenceCodes, ['tool_error'])
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
