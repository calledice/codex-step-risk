const byId = id => document.getElementById(id)
const params = new URLSearchParams(location.search)
let selectedSessionId = params.get('sessionId') || ''
let selectedTurnId = ''
let pageEpoch = 0
let dashboard = null
let refreshPromise = null
let refreshAgain = false
let settingsDirty = false
let settingsSaving = false
let baselineReady = false
let seenEvents = new Set()
let requestChain = Promise.resolve()
let csrfToken = ''
let assessing = false
let activeJob = null
const assessmentQueue = []
const assessmentStates = new Map()
const assessmentOverrides = new Map()
const evidenceStates = new Map()
const expandedDetails = new Set()
const renderedCards = new Map()
const pendingAutoEvents = new Map()

function element(tag, className, text = '') {
  const node = document.createElement(tag)
  if (className) node.className = className
  node.textContent = text
  return node
}

function probability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function percent(value) {
  if (!probability(value)) return '—'
  if (value > 0 && value < 0.001) return '<0.1%'
  if (value < 1 && value > 0.999) return '>99.9%'
  return `${(value * 100).toFixed(1)}%`
}

function validAssessment(value) {
  return value && ['rules', 'luna'].includes(value.source) && probability(value.value) &&
    ['problem', 'persistence', 'impact'].every(key => probability(value.factors?.[key])) &&
    Math.abs(value.value - value.factors.problem * value.factors.persistence * value.factors.impact) < 0.00001 &&
    typeof value.summary === 'string'
}

function eventKey(event) {
  return JSON.stringify([event.sessionId, event.turnId, event.ordinal])
}

function settingsKey(settings = dashboard?.taskSettings) {
  return JSON.stringify([settings?.goal || '', settings?.dataMode || 'structured'])
}

function assessmentFor(event) {
  const local = assessmentOverrides.get(eventKey(event))
  const value = local?.settingsKey === settingsKey() ? local.assessment : event.stepFailure
  return validAssessment(value) ? value : null
}

function responseText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value)
}

function shortId(value) {
  return value?.length > 20 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value || '—'
}

function timeText(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function outcome(value) {
  return ({ error: '失败', success: '成功', unknown: '未判定' })[value] || '未判定'
}

function evidenceText(detail) {
  const field = detail.field || ''
  switch (detail.type) {
    case 'exit_code': return `退出码 ${detail.value}（${field}，${detail.value === 0 ? '执行成功' : '执行失败'}）`
    case 'http_status': return `HTTP 状态 ${detail.value}（${field}）`
    case 'status': return `状态字段 ${field}=${detail.value}`
    case 'error_flag': return `${field}=true：工具明确报告错误`
    case 'success_flag': return `${field}=${detail.value}`
    case 'error_field': return '响应含非空 error 字段'
    case 'conflicting_verdicts': return '成功与失败标记冲突，观测采用失败判定'
    case 'response_text_only': return '只有响应文本，没有结构化成功或失败判据'
    case 'response_without_verdict': return '响应缺少可识别的成功或失败判据'
    case 'missing_response': return 'hook 未收到工具响应'
    case 'subagent_no_verdict': return '子 agent 已结束，但没有任务验收结果'
    default: return `${detail.type || '其他观测信号'}${field ? ` · ${field}` : ''}${Object.hasOwn(detail, 'value') ? ` = ${responseText(detail.value)}` : ''}`
  }
}

function detailPanel(event, suffix, label) {
  const details = element('details', 'step-details')
  const key = `${eventKey(event)}:${suffix}`
  details.open = expandedDetails.has(key)
  details.append(element('summary', '', label))
  const content = element('div', 'detail-content')
  details.append(content)
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return
    if (details.open) expandedDetails.add(key)
    else expandedDetails.delete(key)
  })
  return { details, content }
}

function addList(parent, title, values) {
  const items = Array.isArray(values) ? values.filter(item => typeof item === 'string' && item) : []
  if (!items.length) return
  parent.append(element('h4', '', title))
  const list = element('ul', 'detail-list')
  list.append(...items.map(item => element('li', '', item)))
  parent.append(list)
}

function renderFactors(event, assessment) {
  const { details, content } = detailPanel(event, 'factors', '为什么是这个概率？')
  if (!assessment) {
    content.append(element('p', '', '尚未收到有效估计，请刷新页面或检查本地服务版本。'))
    return details
  }
  const definitions = [
    ['problem', '本步引入或留下问题', '与当前任务目标相关的问题'],
    ['persistence', '问题保留到任务结束', '假设本步确实留下了问题'],
    ['impact', '遗留问题导致目标失败', '假设问题存在且一直未消除'],
  ]
  const factors = element('dl', 'factor-list')
  for (const [key, title, note] of definitions) {
    const factor = element('div', 'factor')
    const label = element('dt', '', title)
    label.append(element('small', '', note))
    factor.append(label, element('dd', '', percent(assessment.factors[key])))
    factors.append(factor)
  }
  content.append(factors, element('p', 'factor-formula', `三个条件概率相乘 = ${percent(assessment.value)}。使用未四舍五入的原始值计算。`))
  addList(content, '判断理由', assessment.reasons)
  addList(content, '目前的限制', assessment.limitations)
  if (Array.isArray(assessment.evidenceRefs) && assessment.evidenceRefs.length) {
    content.append(element('h4', '', '引用的证据'))
    const refs = element('div', 'evidence-refs')
    refs.append(...assessment.evidenceRefs.map(ref => element('span', 'evidence-ref', String(ref))))
    content.append(refs)
  }
  content.append(element('p', 'factor-formula', '估计时点：此步骤刚完成。后续步骤不改写这次历史预测。'))
  return details
}

function renderObservation(event) {
  const { details, content } = detailPanel(event, 'observation', '观测结果与完整响应')
  const observed = element('div', 'observed-status', '工具观测')
  observed.append(element('span', `pill ${event.outcome}`, outcome(event.outcome)))
  content.append(observed)
  if (event.outcome === 'unknown') content.append(element('p', 'observation-note', '没有可靠的成功或失败字段；概率仍由模型根据可见信息估计。'))
  const evidence = Array.isArray(event.outcomeEvidence) ? event.outcomeEvidence : []
  const legacyLabels = { tool_error: '旧日志：工具错误信号', no_hard_signal: '旧日志：工具提供成功信号', unknown_outcome: '旧日志：缺少结构化结果' }
  const items = evidence.length ? evidence.map(evidenceText)
    : (event.evidenceCodes || []).map(code => legacyLabels[code] || code)
  addList(content, '观测判据', items.length ? items : ['没有结构化判据'])
  if (Object.hasOwn(event, 'response')) {
    const full = responseText(event.response)
    const raw = element('details', 'response-details')
    const key = `${eventKey(event)}:response`
    raw.open = expandedDetails.has(key)
    raw.append(element('summary', '', '展开本地保存的完整响应'), element('pre', 'response-content', full || '（空响应）'))
    raw.addEventListener('toggle', () => {
      if (!raw.isConnected) return
      if (raw.open) expandedDetails.add(key)
      else expandedDetails.delete(key)
    })
    content.append(raw)
  } else content.append(element('p', 'observation-note', '未保存完整响应（旧日志或 hook 未提供）。'))
  return details
}

function renderEvidence(event) {
  const { details, content } = detailPanel(event, 'ai-input', '发送前查看 AI 输入')
  const cacheKey = `${eventKey(event)}:${settingsKey()}`
  const render = () => {
    const state = evidenceStates.get(cacheKey)
    content.replaceChildren(element('p', 'observation-note', '这里展示此步骤实际用于 AI 评估的数据。打开预览不会调用 Luna。'))
    if (state?.status === 'done') content.append(element('pre', 'evidence-content', responseText(state.evidence)))
    else if (state?.status === 'error') {
      content.append(element('p', 'assessment-error', state.message))
      const retry = element('button', 'button', '重试读取摘要')
      retry.type = 'button'
      retry.addEventListener('click', () => load(true))
      content.append(retry)
    } else content.append(element('p', 'assessment-note', state?.status === 'loading' ? '正在读取本地摘要…' : '展开后读取本地摘要。'))
  }
  const load = async (retry = false) => {
    if (!retry && evidenceStates.has(cacheKey)) return
    const epoch = pageEpoch
    evidenceStates.set(cacheKey, { status: 'loading' })
    render()
    try {
      const query = new URLSearchParams({ sessionId: event.sessionId, turnId: event.turnId, ordinal: String(event.ordinal) })
      const data = await api(`/api/evidence?${query}`, {}, () => epoch === pageEpoch)
      if (epoch !== pageEpoch) return
      if (!Object.hasOwn(data, 'evidence')) throw new Error('本地服务没有返回摘要，请刷新页面后重试。')
      evidenceStates.set(cacheKey, { status: 'done', evidence: data.evidence })
    } catch (error) {
      if (epoch !== pageEpoch) return
      evidenceStates.set(cacheKey, { status: 'error', message: error.message })
    }
    if (details.isConnected) render()
    else renderSteps()
  }
  details.addEventListener('toggle', () => { if (details.isConnected && details.open) load() })
  render()
  if (details.open) load()
  return details
}

function renderCard(event) {
  const assessment = assessmentFor(event)
  const state = assessmentStates.get(eventKey(event))
  const card = element('article', 'step-card')
  card.dataset.eventKey = eventKey(event)
  const heading = element('div', 'step-heading')
  const identity = element('div', 'step-identity')
  identity.append(element('span', 'step-ordinal', `#${event.ordinal}`), element('h3', 'step-name', event.toolName || event.actor || event.kind || '步骤'))
  heading.append(identity, element('span', `pill ${event.outcome}`, `观测：${outcome(event.outcome)}`))
  const score = element('div', 'probability-section')
  const value = element('div', '')
  value.append(element('div', 'probability-number', percent(assessment?.value)), element('p', 'probability-label', '引起最终任务失败的概率'))
  const tags = element('div', 'estimate-tags')
  tags.append(element('span', `estimate-source ${assessment?.source || ''}`, assessment?.source === 'luna' ? 'Luna 评估' : '本地模型'))
  tags.append(element('span', 'evidence-quality', ({ low: '判断依据较少', medium: '判断依据一般', high: '判断依据较充分' })[assessment?.evidenceQuality] || '依据质量未知'))
  score.append(value, tags)
  const track = element('div', 'probability-track')
  track.setAttribute('aria-hidden', 'true')
  const fill = element('div', 'probability-fill')
  fill.style.width = `${(assessment?.value || 0) * 100}%`
  track.append(fill)
  card.append(heading, score, track, element('p', 'prediction-summary', assessment?.summary || '等待本地服务提供有效的步骤概率估计。'))
  const actions = element('div', 'card-actions')
  const pending = state?.status === 'queued' || state?.status === 'loading'
  const done = assessment?.source === 'luna'
  const button = element('button', 'button', state?.status === 'loading' ? 'AI 评估中…' : state?.status === 'queued' ? '等待 AI 评估…' : state?.status === 'error' ? '重试 AI 评估' : done ? 'AI 已评估' : 'AI 评估概率')
  button.type = 'button'
  button.disabled = !dashboard?.lunaAvailable || pending || done || settingsSaving || settingsDirty
  button.addEventListener('click', () => enqueueAssessments([event]))
  actions.append(button)
  if (state?.cached) actions.append(element('span', 'assessment-note', '已读取本地缓存'))
  else if (pending) actions.append(element('span', 'assessment-note', '评估期间保留当前概率'))
  else if (!done) actions.append(element('span', 'assessment-note', 'AI 将重新估计这一步的概率'))
  card.append(actions)
  if (state?.status === 'error') card.append(element('p', 'assessment-error', `${state.message} 当前概率已保留。`))
  if (event.outcome === 'unknown' && Object.hasOwn(event, 'response')) {
    const full = responseText(event.response)
    card.append(element('div', 'response-preview', full ? (full.length > 140 ? `${full.slice(0, 140)}…` : full) : '（空响应）'))
  }
  card.append(renderFactors(event, assessment), renderObservation(event), renderEvidence(event))
  return card
}

function selectedTurn() {
  return dashboard?.turns.find(turn => turn.turnId === selectedTurnId)
}

function renderSteps() {
  const turn = selectedTurn()
  const events = [...(turn?.events || [])]
  if (byId('sortSelect').value === 'probability') events.sort((a, b) => (assessmentFor(b)?.value ?? -1) - (assessmentFor(a)?.value ?? -1) || a.ordinal - b.ordinal)
  else events.sort((a, b) => a.ordinal - b.ordinal)
  byId('eventCount').textContent = String(events.length)
  byId('detailTitle').textContent = turn ? `回合 ${shortId(turn.turnId)}` : '等待事件'
  byId('emptyMessage').hidden = events.length > 0
  const cards = events.map(event => {
    const key = eventKey(event)
    const signature = JSON.stringify([event, assessmentFor(event), assessmentStates.get(key),
      evidenceStates.get(`${key}:${settingsKey()}`), settingsKey(), dashboard?.lunaAvailable,
      settingsSaving, settingsDirty])
    const previous = renderedCards.get(key)
    if (previous?.signature === signature) return previous.card
    const card = renderCard(event)
    renderedCards.set(key, { signature, card })
    return card
  })
  const list = byId('stepList')
  for (let index = 0; index < cards.length; index += 1) {
    if (list.children[index] !== cards[index]) list.insertBefore(cards[index], list.children[index] || null)
  }
  while (list.children.length > cards.length) list.lastElementChild.remove()
  const visibleKeys = new Set(events.map(eventKey))
  for (const key of renderedCards.keys()) if (!visibleKeys.has(key)) renderedCards.delete(key)
  renderQueueStatus()
}

function renderQueueStatus() {
  const jobs = assessmentQueue.filter(job => job.epoch === pageEpoch)
  const current = activeJob?.epoch === pageEpoch ? activeJob : null
  const messages = []
  if (current) messages.push(`正在评估步骤 #${current.event.ordinal}`)
  if (jobs.length) messages.push(`另有 ${jobs.length} 步等待`)
  if (messages.length) messages.push('按顺序调用 Luna')
  byId('queueStatus').textContent = messages.join(' · ')
  byId('queueStatus').hidden = messages.length === 0
  const events = selectedTurn()?.events || []
  const pending = events.some(event => ['queued', 'loading'].includes(assessmentStates.get(eventKey(event))?.status))
  const available = events.filter(event => assessmentFor(event)?.source !== 'luna' && !['queued', 'loading'].includes(assessmentStates.get(eventKey(event))?.status))
  const count = Math.min(available.length, 10)
  byId('assessBatch').textContent = available.length ? `AI 评估当前回合（${count} 步）`
    : !events.length ? '暂无可评估步骤' : pending ? '当前回合评估中…' : '当前回合已评估'
  byId('assessBatch').disabled = !dashboard?.lunaAvailable || !available.length || settingsSaving || settingsDirty
  byId('assessBatch').title = '每次最多评估 10 个尚未经过 Luna 评估的步骤'
  if (byId('statusDot').className === 'status-dot ok')
    byId('statusText').textContent = activeJob || assessmentQueue.length
      ? 'AI 评估中，完成后刷新' : '每 2 秒刷新'
}

function setSelectOptions(select, options, value, empty) {
  const signature = JSON.stringify(options)
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...(options.length ? options : [{ value: '', label: empty }]).map(option => {
      const node = element('option', '', option.label)
      node.value = option.value
      return node
    }))
    select.dataset.signature = signature
  }
  select.value = value
  select.disabled = !options.length
}

function renderControls() {
  const sessions = dashboard?.sessions || []
  const current = selectedSessionId
  const options = sessions.map(session => ({ value: session.sessionId, label: `${shortId(session.sessionId)} · ${session.turnCount} 回合` }))
  if (current && !options.some(option => option.value === current)) options.unshift({ value: current, label: `${shortId(current)} · 暂无事件` })
  setSelectOptions(byId('sessionSelect'), options, current, '暂无会话')
  const turns = dashboard?.turns || []
  if (!turns.some(turn => turn.turnId === selectedTurnId)) selectedTurnId = turns[0]?.turnId || ''
  byId('turnCount').textContent = `${turns.length} 个`
  setSelectOptions(byId('turnSelect'), turns.map(turn => ({ value: turn.turnId, label: `${shortId(turn.turnId)} · ${turn.events.length} 步 · ${timeText(turn.updatedAt)}` })), selectedTurnId, '暂无回合')
  const settings = dashboard?.taskSettings || {}
  if (!settingsDirty && !settingsSaving) {
    byId('taskGoal').value = settings.goal || ''
    byId('dataMode').value = settings.dataMode === 'context_summary' ? 'context_summary' : 'structured'
    byId('autoAssess').checked = settings.autoAssess === true
  }
  byId('goalSummary').textContent = settings.goal ? `当前目标：${settings.goal.length > 90 ? `${settings.goal.slice(0, 90)}…` : settings.goal}` : '尚未填写目标 · 使用通用完成要求估计'
  byId('saveSettings').disabled = !selectedSessionId || settingsSaving || !settingsDirty
  byId('taskGoal').disabled = !selectedSessionId || settingsSaving
  byId('dataMode').disabled = !selectedSessionId || settingsSaving
  byId('autoAssess').disabled = !selectedSessionId || settingsSaving
  renderDataModeHelp()
  const provider = dashboard?.lunaProvider
  const destination = `${provider?.name || '当前提供方'}${provider?.host ? `（${provider.host}）` : ''}`
  byId('lunaProviderNotice').textContent = dashboard?.lunaAvailable
    ? `Luna 使用 config.toml 的 ${destination}。每次批量最多 10 步，已完成的评估保存在本地。${settingsDirty ? '设置尚未保存，保存后可继续 AI 评估。' : ''}`
    : 'Luna 暂不可用；当前显示本地模型估计。请检查 config.toml 提供方及其密钥环境变量。'
  byId('version').textContent = dashboard?.version || '0.4.1'
}

function renderDataModeHelp() {
  byId('dataModeHelp').textContent = byId('dataMode').value === 'context_summary'
    ? '发送限长并过滤常见敏感字段的目标、动作、响应摘要及至多 6 个前序步骤。可在每张卡片展开查看实际输入。完整响应保存在本地。'
    : '只发送结构化判据与指标，不发送任务目标、动作正文或响应正文。可以先查看各步骤的实际 AI 输入。'
}

function checkRequestGuard(guard) {
  if (!guard()) throw new Error('页面已切换，此请求已取消。')
}

function validCsrfToken(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
}

async function fetchApiResponse(path, options, guard) {
  checkRequestGuard(guard)
  let response
  try {
    response = await fetch(path, { ...options, mode: 'same-origin',
      referrerPolicy: 'same-origin', cache: 'no-store' })
  } catch {
    checkRequestGuard(guard)
    throw new Error('无法连接本地面板，请确认服务仍在运行后重试。')
  }
  const data = await response.json().catch(() => null)
  checkRequestGuard(guard)
  if (response.ok && (options.method || 'GET').toUpperCase() === 'GET' &&
      path.split('?')[0] === '/api/dashboard')
    csrfToken = validCsrfToken(data?.csrfToken) ? data.csrfToken : ''
  return { response, data }
}

async function refreshCsrfToken(guard) {
  checkRequestGuard(guard)
  try {
    // Use a direct request here: joining requestChain would wait on this POST itself.
    const { response, data } = await fetchApiResponse('/api/dashboard', {}, guard)
    if (!response.ok || !validCsrfToken(data?.csrfToken)) throw new Error('invalid token response')
  } catch {
    checkRequestGuard(guard)
    csrfToken = ''
    throw new Error('无法更新页面安全令牌，请刷新页面后重试。')
  }
}

function api(path, options = {}, guard = () => true) {
  const request = requestChain.then(async () => {
    checkRequestGuard(guard)
    const isPost = (options.method || 'GET').toUpperCase() === 'POST'
    if (isPost && !validCsrfToken(csrfToken)) await refreshCsrfToken(guard)
    const send = () => {
      const headers = new Headers(options.headers)
      if (isPost) headers.set('X-Step-Risk-Token', csrfToken)
      return fetchApiResponse(path, { ...options, headers }, guard)
    }
    let { response, data } = await send()
    if (isPost && response.status === 403 && data?.error?.code === 'csrf_token_invalid') {
      csrfToken = ''
      await refreshCsrfToken(guard)
      ;({ response, data } = await send())
    }
    if (!response.ok) throw new Error(typeof data?.error?.message === 'string' ? data.error.message : `本地服务返回 HTTP ${response.status}，请稍后重试。`)
    if (!data || typeof data !== 'object') throw new Error('本地服务返回了无效数据，请刷新后重试。')
    return data
  })
  requestChain = request.catch(() => {})
  return request
}

function enqueueAssessments(events, automatic = false) {
  if (!dashboard?.lunaAvailable || settingsSaving || settingsDirty) return []
  const handledKeys = []
  for (const event of events) {
    if (event.sessionId !== selectedSessionId) continue
    const key = eventKey(event)
    handledKeys.push(key)
    if (assessmentFor(event)?.source === 'luna' || ['queued', 'loading'].includes(assessmentStates.get(key)?.status)) continue
    assessmentStates.set(key, { status: 'queued' })
    assessmentQueue.push({ event, epoch: pageEpoch, settingsKey: settingsKey(), automatic })
  }
  renderSteps()
  processAssessments()
  return handledKeys
}

function flushAutoAssessments() {
  if (dashboard?.taskSettings?.autoAssess !== true) { pendingAutoEvents.clear(); return }
  if (!dashboard?.lunaAvailable || settingsSaving || settingsDirty || !pendingAutoEvents.size) return
  const capacity = Math.max(0, 10 - assessmentQueue.length - (activeJob ? 1 : 0))
  const events = [...pendingAutoEvents.values()].slice(0, capacity)
  if (!events.length) return
  for (const key of enqueueAssessments(events, true)) pendingAutoEvents.delete(key)
}

async function processAssessments() {
  if (assessing) return
  assessing = true
  try {
    while (assessmentQueue.length) {
      const job = assessmentQueue.shift()
      if (job.epoch !== pageEpoch || job.event.sessionId !== selectedSessionId || job.settingsKey !== settingsKey()) continue
      activeJob = job
      const key = eventKey(job.event)
      assessmentStates.set(key, { status: 'loading' })
      renderSteps()
      try {
        const data = await api('/api/assess', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: job.event.sessionId, turnId: job.event.turnId, ordinal: job.event.ordinal }),
        }, () => job.epoch === pageEpoch && job.settingsKey === settingsKey())
        if (job.epoch !== pageEpoch || job.settingsKey !== settingsKey()) continue
        if (!validAssessment(data.assessment) || data.assessment.source !== 'luna') throw new Error('Luna 返回了无效概率，未覆盖当前估计。')
        assessmentOverrides.set(key, { settingsKey: job.settingsKey, assessment: data.assessment })
        assessmentStates.set(key, { status: 'done', cached: data.cached === true })
      } catch (error) {
        if (job.epoch === pageEpoch) assessmentStates.set(key, { status: 'error', message: error.message })
      } finally {
        activeJob = null
        renderSteps()
      }
    }
  } finally { assessing = false; renderQueueStatus() }
}

function cancelQueuedAssessments() {
  for (const job of assessmentQueue) {
    const key = eventKey(job.event)
    assessmentStates.delete(key)
    if (job.automatic) pendingAutoEvents.set(key, job.event)
  }
  assessmentQueue.length = 0
  if (activeJob) {
    const key = eventKey(activeJob.event)
    assessmentStates.delete(key)
    if (activeJob.automatic) pendingAutoEvents.set(key, activeJob.event)
  }
}

async function readDashboard() {
  const epoch = pageEpoch
  try {
    const suffix = selectedSessionId ? `?sessionId=${encodeURIComponent(selectedSessionId)}` : ''
    const data = await api(`/api/dashboard${suffix}`, {}, () => epoch === pageEpoch)
    if (epoch !== pageEpoch) return
    if (!Array.isArray(data.sessions) || !Array.isArray(data.turns)) throw new Error('无效面板数据')
    if (dashboard && settingsKey(data.taskSettings) !== settingsKey(dashboard.taskSettings)) {
      assessmentOverrides.clear()
      evidenceStates.clear()
      cancelQueuedAssessments()
    }
    dashboard = data
    // A completed dashboard request includes the persisted assessment cache.
    assessmentOverrides.clear()
    selectedSessionId = data.selectedSessionId || ''
    const allEvents = data.turns.flatMap(turn => turn.events)
    for (const event of allEvents) {
      const key = eventKey(event)
      const state = assessmentStates.get(key)
      if ((state?.status === 'done' && event.stepFailure?.source !== 'luna') ||
          (state?.status === 'error' && event.stepFailure?.source === 'luna')) assessmentStates.delete(key)
    }
    const newEvents = baselineReady ? allEvents.filter(event => !seenEvents.has(eventKey(event))) : []
    for (const event of allEvents) seenEvents.add(eventKey(event))
    if (data.taskSettings?.autoAssess === true) {
      for (const event of newEvents) pendingAutoEvents.set(eventKey(event), event)
    }
    baselineReady = true
    renderControls()
    renderSteps()
    byId('statusDot').className = 'status-dot ok'
    renderQueueStatus()
    byId('statusText').title = ''
    byId('lastUpdated').textContent = `更新于 ${timeText(data.updatedAt)}`
    flushAutoAssessments()
  } catch (error) {
    if (epoch !== pageEpoch) return
    byId('statusDot').className = 'status-dot error'
    byId('statusText').textContent = '读取失败 · 正在重试'
    byId('statusText').title = error.message
  }
}

function refresh() {
  if (refreshPromise) { refreshAgain = true; return refreshPromise }
  refreshPromise = (async () => {
    do { refreshAgain = false; await readDashboard() } while (refreshAgain)
  })().finally(() => { refreshPromise = null })
  return refreshPromise
}

byId('sessionSelect').addEventListener('change', event => {
  pageEpoch += 1
  cancelQueuedAssessments()
  selectedSessionId = event.target.value
  selectedTurnId = ''
  dashboard = null
  settingsDirty = false
  settingsSaving = false
  baselineReady = false
  seenEvents = new Set()
  assessmentStates.clear()
  assessmentOverrides.clear()
  evidenceStates.clear()
  pendingAutoEvents.clear()
  byId('settingsStatus').textContent = ''
  byId('taskGoal').value = ''
  byId('goalSummary').textContent = '正在读取此会话的目标…'
  byId('dataMode').value = 'structured'
  byId('autoAssess').checked = false
  byId('dataModeHelp').textContent = '正在读取此会话的 AI 设置…'
  byId('lunaProviderNotice').textContent = '正在读取此会话的 AI 设置…'
  byId('detailTitle').textContent = '正在读取步骤…'
  byId('eventCount').textContent = '0'
  byId('turnSelect').replaceChildren(element('option', '', '正在读取回合…'))
  byId('turnSelect').dataset.signature = ''
  byId('turnSelect').disabled = true
  byId('emptyMessage').hidden = false
  byId('stepList').replaceChildren()
  byId('assessBatch').disabled = true
  byId('taskGoal').disabled = true
  byId('dataMode').disabled = true
  byId('autoAssess').disabled = true
  byId('saveSettings').disabled = true
  byId('queueStatus').hidden = true
  const url = new URL(location.href)
  if (selectedSessionId) url.searchParams.set('sessionId', selectedSessionId)
  else url.searchParams.delete('sessionId')
  history.replaceState(null, '', url)
  refresh()
})

byId('turnSelect').addEventListener('change', event => { selectedTurnId = event.target.value; renderSteps() })
byId('sortSelect').addEventListener('change', renderSteps)
byId('assessBatch').addEventListener('click', () => {
  const events = (selectedTurn()?.events || []).filter(event => assessmentFor(event)?.source !== 'luna' && !['queued', 'loading'].includes(assessmentStates.get(eventKey(event))?.status)).slice(0, 10)
  enqueueAssessments(events)
})

for (const id of ['taskGoal', 'dataMode', 'autoAssess']) byId(id).addEventListener('input', () => {
  settingsDirty = true
  byId('settingsStatus').className = 'inline-status'
  byId('settingsStatus').textContent = '设置尚未保存'
  renderControls()
  renderSteps()
})

byId('settingsForm').addEventListener('submit', async event => {
  event.preventDefault()
  if (!selectedSessionId || settingsSaving) return
  const payload = { sessionId: selectedSessionId, goal: byId('taskGoal').value.trim(), dataMode: byId('dataMode').value, autoAssess: byId('autoAssess').checked }
  pageEpoch += 1
  const epoch = pageEpoch
  cancelQueuedAssessments()
  settingsSaving = true
  byId('settingsStatus').className = 'inline-status'
  byId('settingsStatus').textContent = '正在保存…'
  renderControls()
  renderSteps()
  try {
    const result = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, () => epoch === pageEpoch)
    if (epoch !== pageEpoch) return
    dashboard.taskSettings = result.taskSettings || result
    assessmentOverrides.clear()
    assessmentStates.clear()
    evidenceStates.clear()
    settingsDirty = false
    byId('settingsStatus').textContent = '已保存，正在刷新估计'
    await refresh()
    if (epoch === pageEpoch) byId('settingsStatus').textContent = '已保存'
  } catch (error) {
    if (epoch !== pageEpoch) return
    byId('settingsStatus').className = 'inline-status error'
    byId('settingsStatus').textContent = error.message
  } finally {
    if (epoch === pageEpoch) {
      settingsSaving = false
      renderControls()
      renderSteps()
      flushAutoAssessments()
    }
  }
})

refresh()
setInterval(refresh, 2000)
