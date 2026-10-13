import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { loadDashboard } from '../plugins/codex-step-risk/scripts/dashboard-data.mjs'
import { startDashboard } from '../plugins/codex-step-risk/scripts/dashboard-server.mjs'
import { LunaError } from '../plugins/codex-step-risk/scripts/luna-explain.mjs'

const temp = () => mkdtempSync(join(tmpdir(), 'step-risk-dashboard-'))
const snapshot = (sessionId, turnId, ordinal, extra = {}) => ({
  sessionId, turnId, ordinal, kind: 'tool', toolName: 'Bash',
  outcome: 'unknown', evidenceCodes: ['unknown_outcome'],
  pCurrent: 0.15, pResidual: 0.6,
  taskFailureRisk: { status: 'unavailable_no_success_data', value: null },
  topCandidates: [{ ordinal, kind: 'tool', toolName: 'Bash', actor: 'unknown_agent',
    role: 'executor', weight: 0.15, eventId: 'tool:one' }],
  ...extra,
})

function fixture(dir) {
  const logs = join(dir, 'logs')
  mkdirSync(logs)
  writeFileSync(join(logs, 'one.jsonl'), [
    JSON.stringify(snapshot('session-one', 'turn-one', 1, {
      privateBody: 'PRIVATE_SECRET',
      response: { output: 'COMPLETE_RESPONSE', nested: { value: 'full' } },
      outcomeEvidence: [{ type: 'response_without_verdict' }],
    })),
    JSON.stringify(snapshot('session-two', 'other-turn', 1, { privateBody: 'OTHER_SESSION_SECRET' })),
    JSON.stringify(snapshot('session-one', 'turn-one', 2, { outcome: 'error', pCurrent: 0.5 })),
    '{incomplete',
  ].join('\n'))
  writeFileSync(join(logs, 'two.jsonl'), JSON.stringify(snapshot('session-two', 'turn-two', 1)))
}

test('dashboard reader filters sessions, ignores incomplete tails, and whitelists fields', () => {
  const dir = temp()
  try {
    fixture(dir)
    const result = loadDashboard(dir, 'session-one')
    assert.equal(result.selectedSessionId, 'session-one')
    assert.equal(result.turns.length, 1)
    assert.equal(result.turns[0].events.length, 2)
    assert.equal(result.turns[0].events[1].outcome, 'error')
    assert.equal(result.turns[0].events[1].pCurrent, 0.5)
    assert.ok(result.turns[0].latest.taskFailureRisk.value > 0.2)
    assert.deepEqual(result.turns[0].events[0].response,
      { output: 'COMPLETE_RESPONSE', nested: { value: 'full' } })
    assert.deepEqual(result.turns[0].events[0].outcomeEvidence,
      [{ type: 'response_without_verdict' }])
    assert.ok(!JSON.stringify(result).includes('PRIVATE_SECRET'))
    assert.ok(!JSON.stringify(result).includes('other-turn'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('dashboard server exposes a bounded read-only API', async () => {
  const dir = temp()
  let server
  try {
    fixture(dir)
    server = await startDashboard({ dataDir: dir, port: 0,
      lunaConnection: { provider: 'test', host: 'provider.example',
        apiUrl: 'https://provider.example/v1/responses', apiKey: '' } })
    const base = `http://127.0.0.1:${server.address().port}`
    const response = await fetch(`${base}/api/dashboard?sessionId=session-one`)
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.turns[0].events.length, 2)
    assert.equal(data.turns[0].events[0].response.output, 'COMPLETE_RESPONSE')
    assert.ok(!JSON.stringify(data).includes('PRIVATE_SECRET'))
    assert.equal((await fetch(`${base}/api/dashboard?sessionId=../../private`)).status, 400)
    const rejectedStatus = await new Promise((resolve, reject) => {
      const probe = request(base, { headers: { Host: 'example.com' } }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      probe.on('error', reject)
      probe.end()
    })
    assert.equal(rejectedStatus, 403)
    assert.equal((await fetch(base)).status, 200)
    assert.equal((await fetch(`${base}/api/explain`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Step-Risk-Token': data.csrfToken },
      body: JSON.stringify({ sessionId: 'session-one', turnId: 'turn-one', ordinal: 1 }) })).status, 503)
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a full unknown response remains readable when a log exceeds the old size cap', () => {
  const dir = temp()
  try {
    const logs = join(dir, 'logs')
    mkdirSync(logs)
    const full = 'R'.repeat(4 * 1024 * 1024 + 1)
    writeFileSync(join(logs, 'large.jsonl'), JSON.stringify(
      snapshot('large-session', 'large-turn', 1, { response: full })) + '\n')
    const result = loadDashboard(dir, 'large-session')
    assert.equal(result.turns[0].events[0].response.length, full.length)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Luna endpoint sends only selected structured evidence and rejects other origins', async () => {
  const dir = temp()
  let server
  let received
  try {
    fixture(dir)
    server = await startDashboard({ dataDir: dir, port: 0,
      lunaConnection: { provider: 'test', host: 'provider.example',
        apiUrl: 'https://provider.example/v1/responses', apiKey: 'test-key' },
      explain: async (evidence, connection) => {
        assert.equal(connection.apiKey, 'test-key')
        assert.equal(connection.apiUrl, 'https://provider.example/v1/responses')
        if (evidence.outcome === 'error') throw new Error('PRIVATE_UPSTREAM_SECRET')
        received = evidence
        return { summary: '未判定', basis: ['无结构化判据'], limits: '不能判断工具是否成功' }
      },
    })
    const base = `http://127.0.0.1:${server.address().port}`
    const body = JSON.stringify({ sessionId: 'session-one', turnId: 'turn-one', ordinal: 1 })
    const { csrfToken } = await (await fetch(`${base}/api/dashboard`)).json()
    const response = await fetch(`${base}/api/explain`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Step-Risk-Token': csrfToken }, body })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.explanation.summary, '未判定')
    const dashboard = await (await fetch(`${base}/api/dashboard`)).json()
    assert.equal(dashboard.lunaProvider.host, 'provider.example')
    assert.equal(dashboard.lunaAvailable, true)
    assert.ok(!JSON.stringify(dashboard).includes('test-key'))
    assert.ok(!JSON.stringify(received).includes('COMPLETE_RESPONSE'))
    assert.ok(!JSON.stringify(received).includes('session-one'))
    assert.equal(received.outcome, 'unknown')
    assert.equal((await fetch(`${base}/api/explain`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body })).status, 403)
    assert.equal((await fetch(`${base}/api/explain`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Step-Risk-Token': csrfToken },
      body: JSON.stringify({ sessionId: 'session-one', turnId: 'turn-one', ordinal: 999 }) })).status, 404)
    assert.equal((await fetch(`${base}/api/explain`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Step-Risk-Token': csrfToken },
      body: JSON.stringify({ sessionId: '../../private', turnId: 'turn-one', ordinal: 1 }) })).status, 400)
    assert.equal((await fetch(`${base}/api/explain`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Step-Risk-Token': csrfToken },
      body: 'x'.repeat(2100) })).status, 413)
    const failed = await fetch(`${base}/api/explain`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Step-Risk-Token': csrfToken },
      body: JSON.stringify({ sessionId: 'session-one', turnId: 'turn-one', ordinal: 2 }) })
    assert.equal(failed.status, 502)
    assert.ok(!(await failed.text()).includes('PRIVATE_UPSTREAM_SECRET'))
    assert.equal((await fetch(`${base}/api/explain`)).status, 405)
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Luna endpoint exposes a safe actionable failure and retry count', async () => {
  const dir = temp()
  let server
  try {
    fixture(dir)
    server = await startDashboard({ dataDir: dir, port: 0,
      lunaConnection: { provider: 'test', apiUrl: 'https://provider.example/v1/responses', apiKey: 'test-key' },
      explain: async () => {
        const error = new LunaError('timeout', { attempts: 2 })
        error.message = 'PRIVATE_UPSTREAM_SECRET'
        throw error
      },
    })
    const base = `http://127.0.0.1:${server.address().port}`
    const { csrfToken } = await (await fetch(`${base}/api/dashboard`)).json()
    const response = await fetch(`${base}/api/explain`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, 'X-Step-Risk-Token': csrfToken },
      body: JSON.stringify({ sessionId: 'session-one', turnId: 'turn-one', ordinal: 1 }) })
    assert.equal(response.status, 504)
    const result = await response.json()
    assert.equal(result.error.code, 'timeout')
    assert.equal(result.error.attempts, 2)
    assert.match(result.error.message, /超时/)
    assert.match(result.error.message, /已自动重试 1 次/)
    assert.ok(!JSON.stringify(result).includes('PRIVATE_'))
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
