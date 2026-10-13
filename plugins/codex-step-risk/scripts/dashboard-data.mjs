import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { nextRiskScore, riskEstimate } from './risk.mjs'
import { estimateStepFailure } from './step-probability.mjs'

const MAX_FILES = 200
const MAX_EVENTS = 300
const CONTEXT_EVENTS = 6
const MAX_SESSIONS = 30
const MAX_TURNS = 30
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/
const EVIDENCE_TYPES = new Set([
  'missing_response', 'response_text_only', 'response_without_verdict',
  'error_flag', 'success_flag', 'exit_code', 'status', 'http_status',
  'error_field', 'conflicting_verdicts', 'subagent_no_verdict',
])

export function validSessionId(value) {
  return value === null || value === undefined || value === '' ||
    (typeof value === 'string' && SAFE_ID.test(value))
}

function boundedText(value, max = 128) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function probability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value : null
}

function candidate(value) {
  if (!value || typeof value !== 'object') return null
  return {
    ordinal: Number.isSafeInteger(value.ordinal) ? value.ordinal : null,
    kind: boundedText(value.kind, 24),
    role: boundedText(value.role, 24),
    actor: boundedText(value.actor),
    toolName: boundedText(value.toolName),
    weight: probability(value.weight),
  }
}

function evidenceDetail(value) {
  if (!value || typeof value !== 'object' || !EVIDENCE_TYPES.has(value.type))
    return null
  const detail = { type: value.type }
  if (typeof value.field === 'string') detail.field = boundedText(value.field, 32)
  if (typeof value.value === 'string') detail.value = boundedText(value.value, 128)
  else if (typeof value.value === 'number' && Number.isFinite(value.value))
    detail.value = value.value
  else if (typeof value.value === 'boolean') detail.value = value.value
  return detail
}

function sanitize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!validSessionId(value.sessionId) || !value.sessionId ||
      !validSessionId(value.turnId) || !value.turnId ||
      !Number.isSafeInteger(value.ordinal) || value.ordinal < 1) return null
  const risk = value.taskFailureRisk
  const riskValue = probability(risk?.value)
  const event = {
    sessionId: value.sessionId,
    turnId: value.turnId,
    ordinal: value.ordinal,
    kind: boundedText(value.kind, 24),
    role: boundedText(value.role, 24),
    actor: boundedText(value.actor),
    toolName: boundedText(value.toolName),
    outcome: ['error', 'success', 'unknown'].includes(value.outcome)
      ? value.outcome : 'unknown',
    evidenceCodes: Array.isArray(value.evidenceCodes)
      ? value.evidenceCodes.filter(code => typeof code === 'string').slice(0, 8)
        .map(code => boundedText(code, 64)) : [],
    outcomeEvidence: Array.isArray(value.outcomeEvidence)
      ? value.outcomeEvidence.slice(0, 12).map(evidenceDetail).filter(Boolean) : [],
    operation: ['action', 'read', 'verification', 'unknown'].includes(value.operation)
      ? value.operation : undefined,
    ...(value.stepContext && typeof value.stepContext === 'object' ? { stepContext: {
      actionSummary: boundedText(value.stepContext.actionSummary, 1600),
      responseSummary: boundedText(value.stepContext.responseSummary, 2400),
    } } : {}),
    ...(value.outcome === 'unknown' && Object.hasOwn(value, 'response')
      ? { response: value.response } : {}),
    pCurrent: probability(value.pCurrent),
    pResidual: probability(value.pResidual),
    taskFailureRisk: riskValue !== null &&
      ['assumption_based_uncalibrated', 'calibrated'].includes(risk?.status)
      ? { status: risk.status, value: riskValue,
        baseline: probability(risk.baseline),
        score: typeof risk.score === 'number' && Number.isFinite(risk.score) &&
          risk.score >= 0 && risk.score <= 3 ? risk.score : null,
        modelVersion: boundedText(risk.modelVersion, 64) }
      : { status: 'unavailable', value: null },
    topCandidates: Array.isArray(value.topCandidates)
      ? value.topCandidates.slice(0, 3).map(candidate).filter(Boolean) : [],
  }
  event.stepFailure = estimateStepFailure(event)
  return event
}

function readSnapshots(path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  const events = []
  const riskScores = new Map()
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const event = sanitize(JSON.parse(line))
      if (event) {
        const key = event.sessionId + '\0' + event.turnId
        const score = nextRiskScore(riskScores.get(key) ?? 0, event.outcome)
        riskScores.set(key, score)
        if (event.taskFailureRisk.value === null)
          event.taskFailureRisk = riskEstimate(score)
        events.push(event)
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  return events.slice(-(MAX_EVENTS + CONTEXT_EVENTS))
}

export function loadDashboard(dataDir, requestedSessionId = null, { includeAssessmentContext = false } = {}) {
  if (!validSessionId(requestedSessionId)) throw new TypeError('invalid sessionId')
  let files
  try {
    files = readdirSync(join(dataDir, 'logs'), { withFileTypes: true })
      .filter(file => file.isFile() && file.name.endsWith('.jsonl'))
      .map(file => {
        const path = join(dataDir, 'logs', file.name)
        const stat = statSync(path)
        return { path, size: stat.size, modified: stat.mtimeMs }
      })
      .sort((a, b) => b.modified - a.modified)
      .slice(0, MAX_FILES)
  } catch (error) {
    if (error?.code === 'ENOENT') files = []
    else throw error
  }

  const turns = []
  const sessionMap = new Map()
  for (const file of files) {
    const snapshots = readSnapshots(file.path)
    if (snapshots.length === 0) continue
    const latest = snapshots.at(-1)
    const matchingEvents = snapshots.filter(event => event.sessionId === latest.sessionId &&
      event.turnId === latest.turnId)
    const events = matchingEvents.slice(-MAX_EVENTS)
    const assessmentContext = matchingEvents.slice(0, Math.max(0, matchingEvents.length - MAX_EVENTS))
    const updatedAt = new Date(file.modified).toISOString()
    if (!sessionMap.has(latest.sessionId))
      sessionMap.set(latest.sessionId, { sessionId: latest.sessionId, updatedAt, turnCount: 0 })
    sessionMap.get(latest.sessionId).turnCount += 1
    turns.push({ sessionId: latest.sessionId, turnId: latest.turnId,
      updatedAt, latest, events, ...(includeAssessmentContext ? { assessmentContext } : {}) })
  }

  const sessions = [...sessionMap.values()].slice(0, MAX_SESSIONS)
  const selectedSessionId = requestedSessionId || sessions[0]?.sessionId || null
  return {
    selectedSessionId,
    sessions,
    turns: turns.filter(turn => turn.sessionId === selectedSessionId).slice(0, MAX_TURNS),
    updatedAt: new Date().toISOString(),
  }
}
