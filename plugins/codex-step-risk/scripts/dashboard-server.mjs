import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadDashboard, validSessionId } from './dashboard-data.mjs'
import { buildLunaEvidence, explainWithLuna, LunaError, publicLunaFailure } from './luna-explain.mjs'
import { loadCodexLunaConnection } from './codex-provider.mjs'
import { buildAssessmentEvidence } from './assessment-context.mjs'
import { assessWithLuna } from './luna-assess.mjs'
import { assessmentFingerprint, loadTaskSettings, saveTaskSettings, validTaskSettings,
  readAssessment, writeAssessment } from './assessment-store.mjs'

const assets = new Map([
  ['/', ['../assets/dashboard.html', 'text/html; charset=utf-8']],
  ['/dashboard.css', ['../assets/dashboard.css', 'text/css; charset=utf-8']],
  ['/dashboard.js', ['../assets/dashboard.js', 'text/javascript; charset=utf-8']],
])

function defaultDataDir() {
  const codexHome = process.env.CODEX_HOME
  const home = codexHome && isAbsolute(codexHome) ? codexHome : join(homedir(), '.codex')
  return join(home, 'codex-step-risk')
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

function rejectLocalRequest(response, code, message) {
  send(response, 403, 'application/json; charset=utf-8', JSON.stringify({ error: { code, message } }))
}

function authorizeWrite(request, response, host, csrfToken) {
  const origin = request.headers.origin
  const site = request.headers['sec-fetch-site']
  const exactOrigin = origin === `http://${host}`
  // Some local browser requests lose the Origin port. Only accept that observed
  // form with both same-origin Fetch Metadata and a token read by the local page.
  const portlessOrigin = origin === `http://${host.split(':')[0]}` && site === 'same-origin'
  if ((!exactOrigin && !portlessOrigin) || (site !== undefined && site !== 'same-origin')) {
    rejectLocalRequest(response, 'origin_rejected', '请求来源校验未通过，请从当前本地面板地址刷新后重试。')
    return false
  }
  const token = request.headers['x-step-risk-token']
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))) {
    rejectLocalRequest(response, 'csrf_token_invalid', '本地面板连接凭据已失效，请刷新页面后重试。')
    return false
  }
  return true
}

async function readJsonBody(request, maxBytes = 2048) {
  if (Number(request.headers['content-length']) > maxBytes)
    throw new RangeError('request too large')
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw new RangeError('request too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function validExplainRequest(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.sessionId === 'string' && value.sessionId.length > 0 &&
    validSessionId(value.sessionId) &&
    typeof value.turnId === 'string' && value.turnId.length > 0 &&
    validSessionId(value.turnId) &&
    Number.isSafeInteger(value.ordinal) && value.ordinal > 0
}

export async function startDashboard({ dataDir = defaultDataDir(), port = 43147,
  lunaConnection = loadCodexLunaConnection(), explain = explainWithLuna,
  assess = assessWithLuna } = {}) {
  if (!isAbsolute(dataDir)) throw new TypeError('dataDir must be absolute')
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new RangeError('port must be between 0 and 65535')
  const csrfToken = randomBytes(32).toString('hex')
  const inflight = new Map()
  let assessmentQueue = Promise.resolve()
  const fingerprintFor = (evidence, settings) => assessmentFingerprint(evidence, settings, lunaConnection)
  function selectEvent(input) {
    const turn = loadDashboard(dataDir, input.sessionId, { includeAssessmentContext: true }).turns.find(item => item.turnId === input.turnId)
    const event = turn?.events.find(item => item.ordinal === input.ordinal)
    if (!event) return null
    const settings = loadTaskSettings(dataDir, input.sessionId)
    const evidence = buildAssessmentEvidence(event,
      [...turn.assessmentContext, ...turn.events].filter(item => item.ordinal < event.ordinal).slice(-6), settings)
    return { event, settings, evidence, fingerprint: fingerprintFor(evidence, settings) }
  }
  function enrichedDashboard(sessionId) {
    const dashboard = loadDashboard(dataDir, sessionId, { includeAssessmentContext: true })
    const taskSettings = loadTaskSettings(dataDir, dashboard.selectedSessionId)
    for (const turn of dashboard.turns) {
      const history = [...turn.assessmentContext, ...turn.events]
      for (let i = 0; i < turn.events.length; i++) {
        const event = turn.events[i]
        const index = i + turn.assessmentContext.length
        const evidence = buildAssessmentEvidence(event, history.slice(Math.max(0, index - 6), index), taskSettings)
        const cached = readAssessment(dataDir, event, fingerprintFor(evidence, taskSettings))
        if (cached) event.stepFailure = cached
      }
      delete turn.assessmentContext
    }
    return { ...dashboard, taskSettings, version: '0.4.1' }
  }
  function sendFailure(response, error) {
    if (error?.code === 'settings_changed') {
      send(response, 409, 'application/json; charset=utf-8', JSON.stringify({ error: {
        code: 'settings_changed', message: '任务设置已变更，请重新评估。',
      } }))
      return
    }
    const failure = publicLunaFailure(error)
    send(response, failure.status, 'application/json; charset=utf-8', JSON.stringify({ error: failure.error }))
  }
  const server = createServer(async (request, response) => {
    const host = request.headers.host || ''
    const hostMatch = /^(127\.0\.0\.1|localhost)(?::(\d+))?$/i.exec(host)
    if (!hostMatch || Number(hostMatch[2] || 80) !== server.address()?.port) {
      rejectLocalRequest(response, 'host_rejected', '本地面板地址或端口不匹配，请使用服务启动时显示的地址。')
      return
    }
    let url
    try { url = new URL(request.url, `http://${host}`) } catch {
      send(response, 400, 'text/plain; charset=utf-8', 'Bad request')
      return
    }
    if (url.pathname === '/api/settings' || url.pathname === '/api/assess') {
      if (request.method !== 'POST') { send(response, 405, 'text/plain', 'Method not allowed'); return }
      if (!authorizeWrite(request, response, host, csrfToken)) return
      if (!request.headers['content-type']?.startsWith('application/json')) {
        send(response, 415, 'text/plain', 'JSON required'); return
      }
      let input
      try { input = await readJsonBody(request, url.pathname === '/api/settings' ? 16384 : 2048) }
      catch (error) { send(response, error instanceof RangeError ? 413 : 400, 'text/plain', 'Invalid request'); return }
      if (url.pathname === '/api/settings') {
        if (!validTaskSettings(input)) { send(response, 400, 'text/plain', 'Invalid settings'); return }
        try {
          const taskSettings = saveTaskSettings(dataDir, input)
          send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ taskSettings }))
        } catch { send(response, 500, 'text/plain', 'Unable to save settings') }
        return
      }
      if (!validExplainRequest(input)) { send(response, 400, 'text/plain', 'Invalid event selection'); return }
      try {
        const selected = selectEvent(input)
        if (!selected) { send(response, 404, 'text/plain', 'Event not found'); return }
        const { event, evidence, fingerprint } = selected
        const cached = readAssessment(dataDir, event, fingerprint)
        if (cached) {
          send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ assessment: cached, cached: true })); return
        }
        if (!lunaConnection.apiKey || !lunaConnection.apiUrl) throw new LunaError('not_configured')
        const key = JSON.stringify([event.sessionId, event.turnId, event.ordinal, fingerprint])
        if (!inflight.has(key)) {
          if (inflight.size >= 20) { send(response, 429, 'text/plain', 'Assessment queue is full'); return }
          const verifySettings = () => {
            const current = loadTaskSettings(dataDir, event.sessionId)
            if (fingerprintFor(evidence, current) !== fingerprint)
              throw Object.assign(new Error('settings changed'), { code: 'settings_changed' })
          }
          const work = assessmentQueue.then(async () => {
            verifySettings()
            const existing = readAssessment(dataDir, event, fingerprint)
            if (existing) return existing
            const assessment = await assess(evidence, { apiKey: lunaConnection.apiKey, apiUrl: lunaConnection.apiUrl })
            verifySettings()
            return writeAssessment(dataDir, event, fingerprint, assessment)
          })
          inflight.set(key, work)
          assessmentQueue = work.catch(() => {})
          work.finally(() => inflight.delete(key)).catch(() => {})
        }
        const assessment = await inflight.get(key)
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ assessment, cached: false }))
      } catch (error) { sendFailure(response, error) }
      return
    }
    if (url.pathname === '/api/explain') {
      if (request.method !== 'POST') {
        send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed')
        return
      }
      if (!authorizeWrite(request, response, host, csrfToken)) return
      if (!request.headers['content-type']?.startsWith('application/json')) {
        send(response, 415, 'text/plain; charset=utf-8', 'JSON required')
        return
      }
      if (!lunaConnection.apiKey || !lunaConnection.apiUrl) {
        const failure = publicLunaFailure(new LunaError('not_configured'))
        send(response, failure.status, 'application/json; charset=utf-8',
          JSON.stringify({ error: failure.error }))
        return
      }
      let input
      try { input = await readJsonBody(request) } catch (error) {
        send(response, error instanceof RangeError ? 413 : 400,
          'text/plain; charset=utf-8', 'Invalid request')
        return
      }
      if (!validExplainRequest(input)) {
        send(response, 400, 'text/plain; charset=utf-8', 'Invalid event selection')
        return
      }
      try {
        const turn = loadDashboard(dataDir, input.sessionId).turns
          .find(item => item.turnId === input.turnId)
        const event = turn?.events.find(item => item.ordinal === input.ordinal)
        if (!event) {
          send(response, 404, 'text/plain; charset=utf-8', 'Event not found')
          return
        }
        const explanation = await explain(buildLunaEvidence(event), {
          apiKey: lunaConnection.apiKey, apiUrl: lunaConnection.apiUrl,
        })
        send(response, 200, 'application/json; charset=utf-8',
          JSON.stringify({ explanation }))
      } catch (error) {
        const failure = publicLunaFailure(error)
        send(response, failure.status, 'application/json; charset=utf-8',
          JSON.stringify({ error: failure.error }))
      }
      return
    }
    if (request.method !== 'GET') {
      send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed')
      return
    }
    if (url.pathname === '/api/evidence') {
      const input = { sessionId: url.searchParams.get('sessionId'), turnId: url.searchParams.get('turnId'),
        ordinal: Number(url.searchParams.get('ordinal')) }
      if (!validExplainRequest(input)) { send(response, 400, 'text/plain', 'Invalid event selection'); return }
      try {
        const selected = selectEvent(input)
        if (!selected) { send(response, 404, 'text/plain', 'Event not found'); return }
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify({ evidence: selected.evidence }))
      } catch { send(response, 500, 'text/plain', 'Unable to read evidence') }
      return
    }
    if (url.pathname === '/api/dashboard') {
      const sessionId = url.searchParams.get('sessionId')
      if (!validSessionId(sessionId)) {
        send(response, 400, 'text/plain; charset=utf-8', 'Invalid sessionId')
        return
      }
      try {
        const body = JSON.stringify({ ...enrichedDashboard(sessionId),
          csrfToken,
          lunaAvailable: Boolean(lunaConnection.apiKey && lunaConnection.apiUrl),
          lunaProvider: { name: lunaConnection.provider, host: lunaConnection.host },
        })
        send(response, 200, 'application/json; charset=utf-8', body)
      } catch {
        send(response, 500, 'text/plain; charset=utf-8', 'Unable to read Step Risk logs')
      }
      return
    }
    const asset = assets.get(url.pathname)
    if (!asset) {
      send(response, 404, 'text/plain; charset=utf-8', 'Not found')
      return
    }
    const [relativePath, contentType] = asset
    const body = readFileSync(new URL(relativePath, import.meta.url))
    send(response, 200, contentType, body)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.env.STEP_RISK_DASHBOARD_PORT
    ? Number(process.env.STEP_RISK_DASHBOARD_PORT) : 43147
  const server = await startDashboard({
    dataDir: process.env.STEP_RISK_DATA_DIR || defaultDataDir(), port,
  })
  process.stdout.write(`http://127.0.0.1:${server.address().port}/\n`)
}
