import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { startDashboard } from '../plugins/codex-step-risk/scripts/dashboard-server.mjs'

const selection = { sessionId: 's1', turnId: 't1', ordinal: 1 }
const settings = { sessionId: 's1', goal: 'Original goal', dataMode: 'structured', autoAssess: false }
const assessment = { modelVersion: 'step-failure-chain-v1', status: 'model_estimate',
  value: 0.2, source: 'luna', factors: { problem: 0.5, persistence: 0.8, impact: 0.5 },
  evidenceQuality: 'low', summary: 'Estimate', reasons: ['Target step'], limitations: ['Estimate only'],
  evidenceRefs: ['target'] }

// Use raw HTTP so captured browser headers are reproduced without fetch rewriting them.
function send(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        let data
        try { data = JSON.parse(text) } catch { /* Plain HTTP errors are also tested. */ }
        resolve({ status: res.statusCode, headers: res.headers, data, text })
      })
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

async function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'step-risk-security-'))
  mkdirSync(join(dataDir, 'logs'))
  writeFileSync(join(dataDir, 'logs', 'one.jsonl'), JSON.stringify({ ...selection,
    kind: 'tool', toolName: 'Bash', outcome: 'unknown', evidenceCodes: ['unknown_outcome'] }) + '\n')
  let calls = 0
  const options = { dataDir, port: 0,
    lunaConnection: { provider: 'fixture', apiUrl: 'https://fixture.invalid/responses', apiKey: 'fixture-key' },
    assess: async () => { calls++; return assessment },
    explain: async () => { calls++; return { summary: 'Explanation', basis: ['Target'], limits: 'Estimate' } },
  }
  const servers = []
  t.after(async () => {
    for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve))
    rmSync(dataDir, { recursive: true, force: true })
  })
  const start = async () => {
    const server = await startDashboard(options)
    servers.push(server)
    const base = `http://127.0.0.1:${server.address().port}`
    const page = await send(base, '/api/dashboard')
    return { server, base, token: page.data.csrfToken, page }
  }
  return { ...await start(), start, calls: () => calls }
}

function post(base, path, token, origin = base, extra = {}) {
  return send(base, path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin === undefined ? {} : { Origin: origin }),
      ...(token ? { 'X-Step-Risk-Token': token } : {}), ...extra },
    body: path === '/api/settings' ? settings : selection })
}

test('captured portless same-origin browser requests succeed with a local-page token on every POST route', async t => {
  const f = await fixture(t)
  for (const path of ['/api/assess', '/api/explain', '/api/settings']) {
    const response = await post(f.base, path, f.token, 'http://127.0.0.1',
      { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' })
    assert.equal(response.status, 200, `${path}: ${response.text}`)
  }
  assert.equal(f.calls(), 2)
  assert.equal((await send(f.base, '/api/dashboard')).data.taskSettings.goal, settings.goal)
})

test('every POST requires the server token even with an exact Origin; errors are actionable', async t => {
  const f = await fixture(t)
  assert.match(f.token, /^[a-f0-9]{64}$/)
  assert.equal(f.page.headers['cache-control'], 'no-store')
  assert.equal(f.page.headers['access-control-allow-origin'], undefined)
  for (const path of ['/api/assess', '/api/explain', '/api/settings']) {
    for (const token of [undefined, 'wrong', '0'.repeat(64)]) {
      const response = await post(f.base, path, token)
      assert.equal(response.status, 403)
      assert.equal(response.data.error.code, 'csrf_token_invalid')
      assert.match(response.data.error.message, /刷新/)
      assert.ok(!response.text.includes(f.token))
    }
    assert.equal((await post(f.base, path, undefined, 'http://127.0.0.1',
      { 'Sec-Fetch-Site': 'same-origin' })).status, 403)
  }
  assert.equal(f.calls(), 0)
})

test('tokens do not bypass other origins or cross-site Fetch Metadata', async t => {
  const f = await fixture(t)
  const invalid = [
    ['https://example.com', 'cross-site'], ['null', 'same-origin'], ['', 'same-origin'],
    ['http://127.0.0.1:1', 'same-origin'], ['http://localhost', 'same-origin'],
    ['https://127.0.0.1', 'same-origin'], ['http://127.0.0.1/', 'same-origin'],
    ['http://user@127.0.0.1', 'same-origin'], ['http://127.0.0.1?x=1', 'same-origin'],
    ['http://127.0.0.1', undefined], ['http://127.0.0.1', 'same-site'],
    ['http://127.0.0.1', 'cross-site'], [f.base, 'cross-site'], [f.base, 'same-site'], [f.base, 'none'],
  ]
  for (const path of ['/api/assess', '/api/explain', '/api/settings']) {
    for (const [origin, site] of invalid) {
      const response = await post(f.base, path, f.token, origin,
        site === undefined ? {} : { 'Sec-Fetch-Site': site })
      assert.equal(response.status, 403, `${path}, ${origin}, ${site}`)
      assert.equal(response.data.error.code, 'origin_rejected')
    }
    const missingOrigin = await send(f.base, path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Step-Risk-Token': f.token }, body: selection })
    assert.equal(missingOrigin.status, 403)
    assert.equal(missingOrigin.data.error.code, 'origin_rejected')
  }
  assert.equal(f.calls(), 0)
})

test('Host must match loopback and the listening port; preflight gets no CORS permission', async t => {
  const f = await fixture(t)
  for (const host of ['example.com', '127.0.0.1:1', 'localhost:1', '127.0.0.1']) {
    const response = await send(f.base, '/api/dashboard', { headers: { Host: host } })
    assert.equal(response.status, 403)
    assert.equal(response.data.error.code, 'host_rejected')
    assert.ok(!response.text.includes(f.token))
  }
  const preflight = await send(f.base, '/api/assess', { method: 'OPTIONS',
    headers: { Origin: 'http://127.0.0.1:1', 'Access-Control-Request-Headers': 'x-step-risk-token' } })
  assert.equal(preflight.status, 405)
  assert.equal(preflight.headers['access-control-allow-origin'], undefined)
  assert.equal(preflight.headers['access-control-allow-headers'], undefined)
  const noJson = await send(f.base, '/api/settings', { method: 'POST',
    headers: { Origin: f.base, 'X-Step-Risk-Token': f.token, 'Content-Type': 'text/plain' }, body: settings })
  assert.equal(noJson.status, 415)
  assert.equal(f.calls(), 0)
})

test('tokens rotate after restart; rejected requests do not invoke the model', async t => {
  const f = await fixture(t)
  await new Promise(resolve => f.server.close(resolve))
  const fresh = await f.start()
  assert.notEqual(f.token, fresh.token)
  const rejected = await post(fresh.base, '/api/assess', f.token)
  assert.equal(rejected.status, 403)
  assert.equal(rejected.data.error.code, 'csrf_token_invalid')
  assert.equal(f.calls(), 0)
  assert.equal((await post(fresh.base, '/api/assess', fresh.token)).status, 200)
  assert.equal(f.calls(), 1)
})

test('localhost is supported without treating it as interchangeable with 127.0.0.1', async t => {
  const f = await fixture(t)
  const host = `localhost:${f.server.address().port}`
  for (const origin of [`http://${host}`, 'http://localhost']) {
    const response = await post(f.base, '/api/explain', f.token, origin,
      { Host: host, 'Sec-Fetch-Site': 'same-origin' })
    assert.equal(response.status, 200)
  }
  assert.equal((await post(f.base, '/api/explain', f.token, 'http://127.0.0.1',
    { Host: host, 'Sec-Fetch-Site': 'same-origin' })).status, 403)
  assert.equal(f.calls(), 2)
})
