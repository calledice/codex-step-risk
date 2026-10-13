import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDashboard } from '../plugins/codex-step-risk/scripts/dashboard-server.mjs'
import { loadDashboard } from '../plugins/codex-step-risk/scripts/dashboard-data.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'step-assess-api-'))
  mkdirSync(join(dir, 'logs'))
  const events = [1, 2].map(ordinal => ({ sessionId: 's1', turnId: 't1', ordinal,
    kind: 'tool', role: 'executor', toolName: 'Bash', outcome: 'unknown',
    response: ordinal === 1 ? 'PRIVATE_RESPONSE' : 'FUTURE_RESPONSE',
    outcomeEvidence: [{ type: 'response_text_only' }], evidenceCodes: ['unknown_outcome'] }))
  writeFileSync(join(dir, 'logs', 'one.jsonl'), events.map(JSON.stringify).join('\n') + '\n')
  return dir
}
const connection = { provider: 'fixture', host: 'fixture.invalid',
  apiUrl: 'https://fixture.invalid/responses', apiKey: 'PRIVATE_KEY' }
const result = () => ({ modelVersion: 'step-failure-chain-v1', status: 'model_estimate',
  value: 0.2, source: 'luna', factors: { problem: 0.5, persistence: 0.8, impact: 0.5 },
  evidenceQuality: 'low', summary: '预测结果', reasons: ['来自目标步骤'], limitations: ['模型估计'],
  evidenceRefs: ['target'] })
const close = server => new Promise(resolve => server.close(resolve))
const body = { sessionId: 's1', turnId: 't1', ordinal: 1 }
const post = async (base, path, value, origin = base) => {
  const { csrfToken } = await (await fetch(base + '/api/dashboard')).json()
  return fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: origin, 'X-Step-Risk-Token': csrfToken,
  }, body: JSON.stringify(value) })
}

test('legacy unknown steps have independent non-normalized numeric estimates', () => {
  const dir = fixture()
  try {
    const events = loadDashboard(dir, 's1').turns[0].events
    assert.equal(events[0].stepFailure.value, 0.045)
    assert.equal(events[1].stepFailure.value, 0.045)
    assert.equal(events[0].stepFailure.source, 'rules')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('assessment persists across restarts and settings changes invalidate evidence cache', async () => {
  const dir = fixture()
  let server
  let calls = 0
  let evidence
  const assess = async input => { calls++; evidence = input; return result() }
  try {
    server = await startDashboard({ dataDir: dir, port: 0, lunaConnection: connection, assess })
    let base = `http://127.0.0.1:${server.address().port}`
    const initial = await (await fetch(base + '/api/dashboard?sessionId=s1')).json()
    assert.equal(initial.version, '0.4.1')
    assert.equal(initial.taskSettings.dataMode, 'structured')
    const one = await post(base, '/api/assess', body)
    assert.equal(one.status, 200)
    assert.equal((await one.json()).assessment.value, 0.2)
    assert.ok(!JSON.stringify(evidence).includes('PRIVATE_'))
    assert.ok(!JSON.stringify(evidence).includes('FUTURE_RESPONSE'))
    assert.equal((await (await post(base, '/api/assess', body)).json()).cached, true)
    assert.equal(calls, 1)
    await close(server)
    server = await startDashboard({ dataDir: dir, port: 0, lunaConnection: connection, assess })
    base = `http://127.0.0.1:${server.address().port}`
    const cached = await (await fetch(base + '/api/dashboard?sessionId=s1')).json()
    assert.equal(cached.turns[0].events[0].stepFailure.source, 'luna')
    assert.equal((await (await post(base, '/api/assess', body)).json()).cached, true)
    assert.equal(calls, 1)
    const settings = { sessionId: 's1', goal: '验证两个预期命令', dataMode: 'context_summary', autoAssess: false }
    assert.equal((await post(base, '/api/settings', settings)).status, 200)
    const reset = await (await fetch(base + '/api/dashboard?sessionId=s1')).json()
    assert.equal(reset.turns[0].events[0].stepFailure.source, 'rules')
    assert.equal((await post(base, '/api/assess', body)).status, 200)
    assert.equal(calls, 2)
    const outbound = JSON.stringify(evidence)
    assert.ok(outbound.includes('PRIVATE_RESPONSE'))
    assert.ok(!outbound.includes('FUTURE_RESPONSE'))
    assert.ok(!outbound.includes('PRIVATE_KEY'))
  } finally { if (server) await close(server); rmSync(dir, { recursive: true, force: true }) }
})

test('assessment routes reject cross-origin writes, invalid selections and keep rule fallback', async () => {
  const dir = fixture()
  let server
  try {
    server = await startDashboard({ dataDir: dir, port: 0, lunaConnection: connection,
      assess: async () => { throw new Error('PRIVATE_UPSTREAM_SECRET') } })
    const base = `http://127.0.0.1:${server.address().port}`
    assert.equal((await post(base, '/api/assess', body, 'https://example.com')).status, 403)
    assert.equal((await post(base, '/api/settings', { sessionId: 's1', goal: '', dataMode: 'context_summary', autoAssess: true }, 'https://example.com')).status, 403)
    assert.equal((await post(base, '/api/assess', { ...body, ordinal: 999 })).status, 404)
    assert.equal((await post(base, '/api/settings', { sessionId: '../outside', goal: '' })).status, 400)
    assert.equal((await fetch(base + '/api/evidence?sessionId=s1&turnId=t1&ordinal=1')).status, 200)
    const failed = await post(base, '/api/assess', body)
    assert.equal(failed.status, 502)
    assert.ok(!(await failed.text()).includes('PRIVATE_'))
    const dashboard = await (await fetch(base + '/api/dashboard?sessionId=s1')).json()
    assert.equal(dashboard.turns[0].events[0].stepFailure.source, 'rules')
    assert.equal(dashboard.turns[0].events[0].stepFailure.value, 0.045)
  } finally { if (server) await close(server); rmSync(dir, { recursive: true, force: true }) }
})

test('identical concurrent requests share one model call; queued work rechecks privacy settings', async () => {
  const dir = fixture()
  let server
  let release
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  let calls = 0
  try {
    server = await startDashboard({ dataDir: dir, port: 0, lunaConnection: connection,
      assess: async () => { calls++; entered(); await gate; return result() } })
    const base = `http://127.0.0.1:${server.address().port}`
    const first = post(base, '/api/assess', body)
    await started
    const duplicate = post(base, '/api/assess', body)
    // Wait for both handlers to enter the service before releasing the model.
    await fetch(base + '/api/dashboard?sessionId=s1')
    release()
    assert.equal((await first).status, 200)
    assert.equal((await duplicate).status, 200)
    assert.equal(calls, 1)

    await post(base, '/api/settings', { sessionId: 's1', goal: 'old goal', dataMode: 'context_summary', autoAssess: false })
    let queuedRelease
    let queuedEntered
    const queuedStarted = new Promise(resolve => { queuedEntered = resolve })
    const queuedGate = new Promise(resolve => { queuedRelease = resolve })
    await close(server)
    server = await startDashboard({ dataDir: dir, port: 0, lunaConnection: connection,
      assess: async () => { calls++; queuedEntered(); await queuedGate; return result() } })
    const nextBase = `http://127.0.0.1:${server.address().port}`
    const active = post(nextBase, '/api/assess', body)
    await queuedStarted
    const queued = post(nextBase, '/api/assess', { ...body, ordinal: 2 })
    await fetch(nextBase + '/api/dashboard?sessionId=s1')
    await post(nextBase, '/api/settings', { sessionId: 's1', goal: 'new goal', dataMode: 'structured', autoAssess: false })
    queuedRelease()
    assert.equal((await active).status, 409)
    assert.equal((await queued).status, 409)
    assert.equal(calls, 2, 'queued context must not be sent after privacy mode changes')
    const dashboard = await (await fetch(nextBase + '/api/dashboard?sessionId=s1')).json()
    assert.ok(dashboard.turns[0].events.every(event => event.stepFailure.source === 'rules'))
  } finally { release?.(); if (server) await close(server); rmSync(dir, { recursive: true, force: true }) }
})

test('invalid model output and corrupt persistent cache cannot replace the rule estimate', async () => {
  const dir = fixture()
  let server
  try {
    server = await startDashboard({ dataDir: dir, port: 0, lunaConnection: connection,
      assess: async () => ({ ...result(), value: 0.99 }) })
    let base = `http://127.0.0.1:${server.address().port}`
    assert.equal((await post(base, '/api/assess', body)).status, 502)
    await close(server)
    server = await startDashboard({ dataDir: dir, port: 0, lunaConnection: connection, assess: async () => result() })
    base = `http://127.0.0.1:${server.address().port}`
    assert.equal((await post(base, '/api/assess', body)).status, 200)
    const cache = join(dir, 'assessments', readdirSync(join(dir, 'assessments'))[0])
    writeFileSync(cache, '{broken')
    const dashboard = await (await fetch(base + '/api/dashboard?sessionId=s1')).json()
    assert.equal(dashboard.turns[0].events[0].stepFailure.source, 'rules')
    assert.equal((await post(base, '/api/assess', body)).status, 200)
  } finally { if (server) await close(server); rmSync(dir, { recursive: true, force: true }) }
})

test('moving the display window never changes a visible step assessment context or cache', async () => {
  const dir = fixture()
  let server
  let calls = 0
  const event = ordinal => ({ sessionId: 's1', turnId: 't1', ordinal, kind: 'tool',
    role: 'executor', toolName: 'Bash', outcome: ordinal === 1 ? 'error' : 'unknown' })
  try {
    writeFileSync(join(dir, 'logs', 'one.jsonl'), Array.from({ length: 300 }, (_, n) => JSON.stringify(event(n + 1))).join('\n') + '\n')
    server = await startDashboard({ dataDir: dir, port: 0, lunaConnection: connection,
      assess: async evidence => { calls++; assert.equal(evidence.previous.length, 6); return result() } })
    const base = `http://127.0.0.1:${server.address().port}`
    assert.equal((await post(base, '/api/assess', { ...body, ordinal: 7 })).status, 200)
    appendFileSync(join(dir, 'logs', 'one.jsonl'), JSON.stringify(event(301)) + '\n')
    const data = await (await fetch(base + '/api/dashboard?sessionId=s1')).json()
    assert.equal(data.turns[0].events.length, 300)
    assert.equal(data.turns[0].events.find(item => item.ordinal === 7).stepFailure.source, 'luna')
    assert.equal((await (await post(base, '/api/assess', { ...body, ordinal: 7 })).json()).cached, true)
    assert.equal(calls, 1)
  } finally { if (server) await close(server); rmSync(dir, { recursive: true, force: true }) }
})
