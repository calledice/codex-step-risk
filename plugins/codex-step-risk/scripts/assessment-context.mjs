import { buildLunaEvidence } from './luna-explain.mjs'

const OPERATIONS = new Set(['action', 'read', 'verification', 'unknown'])
const EVIDENCE_CODES = new Set(['tool_error', 'no_hard_signal', 'unknown_outcome'])
const SENSITIVE_FIELD = /pass(?:word|phrase)?|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key/i
const REDACTED = '[redacted]'

function asText(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (key, item) => {
      if (key && SENSITIVE_FIELD.test(key)) return REDACTED
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[circular]'
        seen.add(item)
      }
      if (typeof item === 'string') return redactString(item)
      return typeof item === 'bigint' ? String(item) : item
    }) || ''
  } catch { return '[unavailable]' }
}

// Summaries are a best-effort privacy boundary, not a guarantee that arbitrary
// prose contains no sensitive information. Redact before applying length limits.
function redactString(value) {
  return value
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'`,;]+/gi, REDACTED)
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}/g, REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(--[\w-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|credential)[\w-]*\s+)(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi, '$1[redacted]')
    .replace(/(["']?[\w$.:/-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)[\w.-]*["']?\s*(?:=|:)\s*)(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]"']+)/gi, '$1[redacted]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|]*/g, '[local-path]')
    .replace(/\/(?:Users|home|root)\/[^\s"'<>|]+/g, '[local-path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
}

export function redactText(value, maxLength = 2000) {
  const limit = Number.isSafeInteger(maxLength) && maxLength > 0
    ? Math.min(maxLength, 10000) : 2000
  const text = typeof value === 'string' ? redactString(value) : asText(value)
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)) + '…'
}

export function summarizeStepContext({ toolName, toolInput, response } = {}) {
  const name = redactText(toolName, 100)
  const action = redactText(toolInput, 1100)
  return {
    actionSummary: redactText([name, action].filter(Boolean).join(': '), 1200),
    responseSummary: redactText(response, 2000),
  }
}

function safeStep(event, ref, includeContext) {
  const signals = Array.isArray(event?.signals) ? event.signals.map(signal => ({
    type: signal?.type, field: signal?.marker, value: signal?.value,
  })) : []
  const safe = buildLunaEvidence({ ...event,
    outcomeEvidence: Array.isArray(event?.outcomeEvidence) ? event.outcomeEvidence : signals,
  })
  const result = {
    ref, kind: safe.kind, role: safe.role, outcome: safe.outcome,
    operation: OPERATIONS.has(event?.operation) ? event.operation : 'unknown',
    signals: safe.signals,
    evidenceCodes: Array.isArray(event?.evidenceCodes)
      ? [...new Set(event.evidenceCodes.filter(code => EVIDENCE_CODES.has(code)))].slice(0, 3) : [],
  }
  if (includeContext) {
    const context = event?.stepContext || event || {}
    result.toolName = redactText(event?.toolName, 100)
    result.actionSummary = redactText(context.actionSummary, 1200)
    result.responseSummary = redactText(context.responseSummary ?? event?.response, 2000)
  }
  return result
}

function isPrevious(event, target) {
  if (!event || typeof event !== 'object' || event === target) return false
  for (const field of ['sessionId', 'turnId'])
    if (event[field] && target?.[field] && event[field] !== target[field]) return false
  if (event.eventId && target?.eventId && event.eventId === target.eventId) return false
  return !Number.isSafeInteger(event.ordinal) || !Number.isSafeInteger(target?.ordinal) ||
    event.ordinal < target.ordinal
}

export function buildAssessmentEvidence(event, previousEvents = [], settings = {}) {
  const includeContext = settings?.dataMode === 'context_summary'
  const previous = Array.isArray(previousEvents)
    ? previousEvents.filter(item => isPrevious(item, event)).slice(-6) : []
  return {
    schemaVersion: 1,
    dataMode: includeContext ? 'context_summary' : 'structured',
    ...(includeContext ? { goal: redactText(settings.goal, 2000) } : {}),
    target: safeStep(event, 'target', includeContext),
    previous: previous.map((item, index) => safeStep(item, `previous-${index + 1}`, includeContext)),
  }
}

// Reapply the field allowlist at the actual network boundary so additional local
// fields supplied by a caller can never be serialized into the model request.
export function sanitizeAssessmentEvidence(evidence) {
  const includeContext = evidence?.dataMode === 'context_summary'
  const previous = Array.isArray(evidence?.previous) ? evidence.previous.slice(-6) : []
  return {
    schemaVersion: 1,
    dataMode: includeContext ? 'context_summary' : 'structured',
    ...(includeContext ? { goal: redactText(evidence.goal, 2000) } : {}),
    target: safeStep(evidence?.target, 'target', includeContext),
    previous: previous.map((item, index) => safeStep(item, `previous-${index + 1}`, includeContext)),
  }
}
