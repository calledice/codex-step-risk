import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../plugins/codex-step-risk/assets/dashboard.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../plugins/codex-step-risk/assets/dashboard.html', import.meta.url), 'utf8')
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1])
const firstToken = 'a'.repeat(64)
const nextToken = 'b'.repeat(64)
const postOptions = { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: 'session-one', turnId: 'turn-one', ordinal: 1 }) }

class Element {
  constructor() {
    this.children = []
    this.dataset = {}
    this.style = {}
    this.listeners = {}
    this.value = ''
    this.checked = false
    this.isConnected = true
    this.className = ''
    this._text = ''
    this.parentElement = null
  }
  set textContent(value) { this._text = String(value); this.children = [] }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(' ') }
  append(...nodes) {
    for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node) }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentElement = null
    this.children = []
    this._text = ''
    this.append(...nodes)
  }
  insertBefore(node, reference) {
    node.remove()
    this.children.splice(reference ? this.children.indexOf(reference) : this.children.length, 0, node)
    node.parentElement = this
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1)
      this.parentElement = null
    }
  }
  get lastElementChild() { return this.children.at(-1) }
  addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback) }
  setAttribute() {}
}

function dashboardData(token = firstToken) {
  return { selectedSessionId: 'session-one',
    sessions: [{ sessionId: 'session-one', turnCount: 0 }], turns: [],
    taskSettings: { goal: 'saved goal', dataMode: 'structured', autoAssess: false },
    lunaAvailable: true, version: '0.4.1', updatedAt: '2026-10-10T00:00:00.000Z',
    ...(token === null ? {} : { csrfToken: token }) }
}

function response(status = 200, data = { ok: true }) {
  return { ok: status >= 200 && status < 300, status, json: async () => data }
}

function invalidTokenResponse() {
  return response(403, { error: { code: 'csrf_token_invalid', message: '页面令牌已失效，请刷新后重试。' } })
}

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

async function client(handler, initialToken = firstToken) {
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]))
  nodes.sortSelect.value = 'time'
  const calls = []
  let initial = true
  const context = vm.createContext({
    document: { getElementById: id => nodes[id], createElement: () => new Element() },
    location: { search: '?sessionId=session-one', href: 'http://127.0.0.1:43147/?sessionId=session-one' },
    history: { replaceState() {} }, URL, URLSearchParams, Headers,
    setInterval() {},
    fetch: async (path, options) => {
      const call = { path, options, method: options.method || 'GET', headers: new Headers(options.headers) }
      if (initial) { initial = false; return response(200, dashboardData(initialToken)) }
      calls.push(call)
      return handler(call, calls.length)
    },
  })
  vm.runInContext(source, context, { filename: 'dashboard.js' })
  await vm.runInContext('refreshPromise', context)
  return { api: (...args) => context.api(...args), calls, nodes }
}

test('first POST bootstraps a missing token before sending its original body', async () => {
  const app = await client(call => call.method === 'GET'
    ? response(200, dashboardData(nextToken)) : response(), null)
  await app.api('/api/settings', postOptions)
  assert.deepEqual(app.calls.map(call => [call.method, call.path]), [
    ['GET', '/api/dashboard'], ['POST', '/api/settings'],
  ])
  assert.equal(app.calls[1].headers.get('X-Step-Risk-Token'), nextToken)
  assert.equal(app.calls[1].headers.get('Content-Type'), 'application/json')
  assert.equal(app.calls[1].options.body, postOptions.body)
})

test('successful dashboard responses supply the token for later writes', async () => {
  const app = await client(call => call.method === 'GET'
    ? response(200, dashboardData(nextToken)) : response())
  await app.api('/api/dashboard?sessionId=session-one')
  await app.api('/api/assess', postOptions)
  assert.equal(app.calls.length, 2)
  assert.equal(app.calls[1].headers.get('X-Step-Risk-Token'), nextToken)
})

test('all requests enforce same-origin mode and referrer policy with no-store cache', async () => {
  const app = await client(() => response())
  await app.api('/api/assess', { ...postOptions, mode: 'cors', referrerPolicy: 'unsafe-url', cache: 'force-cache' })
  const options = app.calls[0].options
  assert.equal(options.mode, 'same-origin')
  assert.equal(options.referrerPolicy, 'same-origin')
  assert.equal(options.cache, 'no-store')
  assert.equal(app.calls[0].headers.get('X-Step-Risk-Token'), firstToken)
})

test('service restart refreshes the token directly and retries a rejected POST once', { timeout: 2000 }, async () => {
  const app = await client((call, count) => count === 1 ? invalidTokenResponse()
    : call.method === 'GET' ? response(200, dashboardData(nextToken)) : response())
  await app.api('/api/assess', postOptions)
  assert.deepEqual(app.calls.map(call => call.method), ['POST', 'GET', 'POST'])
  assert.equal(app.calls[0].headers.get('X-Step-Risk-Token'), firstToken)
  assert.equal(app.calls[1].path, '/api/dashboard')
  assert.equal(app.calls[2].headers.get('X-Step-Risk-Token'), nextToken)
  assert.equal(app.calls[0].options.body, app.calls[2].options.body)
  assert.equal(app.nodes.taskGoal.value, 'saved goal')
})

test('persistent CSRF rejection stops after one refresh and one retry', async () => {
  const app = await client(call => call.method === 'GET'
    ? response(200, dashboardData(nextToken)) : invalidTokenResponse())
  await assert.rejects(app.api('/api/assess', postOptions), /页面令牌已失效/)
  assert.deepEqual(app.calls.map(call => call.method), ['POST', 'GET', 'POST'])
})

for (const [status, code] of [[403, 'origin_rejected'], [403, 'other_rejection'], [403, undefined], [400, 'csrf_token_invalid'], [503, 'provider_failed']]) {
  test(`POST HTTP ${status} ${code || 'without a code'} is never automatically retried`, async () => {
    const app = await client(() => response(status, { error: { code, message: 'expected rejection' } }))
    await assert.rejects(app.api('/api/assess', postOptions), /expected rejection/)
    assert.equal(app.calls.length, 1)
  })
}

test('guard cancellation during token bootstrap prevents the first POST', { timeout: 2000 }, async () => {
  let current = true
  const reached = deferred()
  const finish = deferred()
  const app = await client(async () => {
    reached.resolve()
    await finish.promise
    return response(200, dashboardData(nextToken))
  }, null)
  const pending = app.api('/api/settings', postOptions, () => current)
  await reached.promise
  current = false
  finish.resolve()
  await assert.rejects(pending, /页面已切换/)
  assert.deepEqual(app.calls.map(call => call.method), ['GET'])
})

test('guard cancellation during restart token refresh prevents a stale retry', { timeout: 2000 }, async () => {
  let current = true
  const reached = deferred()
  const finish = deferred()
  const app = await client(async (call, count) => {
    if (count === 1) return invalidTokenResponse()
    reached.resolve()
    await finish.promise
    return response(200, dashboardData(nextToken))
  })
  const pending = app.api('/api/assess', postOptions, () => current)
  await reached.promise
  current = false
  finish.resolve()
  await assert.rejects(pending, /页面已切换/)
  assert.deepEqual(app.calls.map(call => call.method), ['POST', 'GET'])
})

test('an already stale queued write sends neither a bootstrap nor a POST', async () => {
  const app = await client(() => { throw new Error('fetch must not run') }, null)
  await assert.rejects(app.api('/api/settings', postOptions, () => false), /页面已切换/)
  assert.equal(app.calls.length, 0)
})

test('a failed token refresh returns a fixed safe message and never retries the POST', async () => {
  const app = await client((call, count) => {
    if (count === 1) return invalidTokenResponse()
    throw new Error('PRIVATE_NETWORK_DIAGNOSTIC')
  })
  await assert.rejects(app.api('/api/assess', postOptions), error => {
    assert.equal(error.message, '无法更新页面安全令牌，请刷新页面后重试。')
    return true
  })
  assert.deepEqual(app.calls.map(call => call.method), ['POST', 'GET'])
})

for (const token of [null, '', 'not-hex'.repeat(10), 'a'.repeat(63)]) {
  test(`an absent or malformed bootstrap token prevents POST (${String(token)?.length || 0} chars)`, async () => {
    const app = await client(() => response(200, dashboardData(token)), null)
    await assert.rejects(app.api('/api/settings', postOptions), /无法更新页面安全令牌/)
    assert.deepEqual(app.calls.map(call => call.method), ['GET'])
  })
}

test('a POST network failure is surfaced without token refresh or automatic resubmission', async () => {
  const app = await client(() => { throw new TypeError('PRIVATE_NETWORK_DIAGNOSTIC') })
  await assert.rejects(app.api('/api/assess', postOptions), error => {
    assert.equal(error.message, '无法连接本地面板，请确认服务仍在运行后重试。')
    return true
  })
  assert.deepEqual(app.calls.map(call => call.method), ['POST'])
})

test('GET CSRF-looking errors are not retried and the request queue recovers', async () => {
  const app = await client((call, count) => count === 1 ? invalidTokenResponse() : response())
  await assert.rejects(app.api('/api/evidence?sessionId=session-one'), /页面令牌已失效/)
  await app.api('/api/settings', postOptions)
  assert.deepEqual(app.calls.map(call => call.method), ['GET', 'POST'])
})
