import { summarizeStepContext } from './assessment-context.mjs'

const FAILURE_STATUSES = new Set(['error', 'failed', 'failure', 'timeout', 'timed_out', 'cancelled', 'canceled', 'aborted'])
const SUCCESS_STATUSES = new Set(['ok', 'success', 'succeeded', 'completed'])
const VALID_EVENTS = new Set(['PostToolUse', 'SubagentStop', 'Stop'])

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function safeName(value) {
  return typeof value === 'string' ? value.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128) : ''
}

export function classifyRole(name, kind) {
  const lower = name.toLowerCase()
  if (kind === 'subagent') {
    if (/review|verif|audit|critic|test/.test(lower)) return 'verifier'
    if (/plan|orchestrat|coordinat/.test(lower)) return 'planner'
    if (/execut|worker|coder|implement|explor/.test(lower)) return 'executor'
    return 'other'
  }
  if (/update_plan|spawn_agent|planner|orchestrat/.test(lower)) return 'planner'
  if (/review|verif|audit/.test(lower)) return 'verifier'
  if (/bash|exec_command|apply_patch|write|edit|mcp__/.test(lower)) return 'executor'
  return 'other'
}

function classifyResponse(response) {
  if (response === undefined || response === null)
    return { outcome: 'unknown', outcomeEvidence: [{ type: 'missing_response' }] }
  if (typeof response === 'string')
    return { outcome: 'unknown', outcomeEvidence: [{ type: 'response_text_only' }] }
  if (typeof response !== 'object' || Array.isArray(response))
    return { outcome: 'unknown', outcomeEvidence: [{ type: 'response_without_verdict' }] }

  const outcomeEvidence = []
  const verdicts = []
  const add = (type, field, value, verdict = null) => {
    outcomeEvidence.push({ type, field,
      value: typeof value === 'string' ? value.slice(0, 128) : value })
    if (verdict) verdicts.push(verdict)
  }
  for (const field of ['isError', 'is_error']) {
    if (typeof response[field] === 'boolean')
      add(response[field] ? 'error_flag' : 'success_flag',
        field, response[field], response[field] ? 'error' : 'success')
  }
  for (const field of ['exit_code', 'exitCode']) {
    if (typeof response[field] === 'number' && Number.isFinite(response[field]))
      add('exit_code', field, response[field], response[field] === 0 ? 'success' : 'error')
  }
  if (typeof response.status === 'string') {
    const status = response.status.trim().toLowerCase()
    add('status', 'status', response.status,
      FAILURE_STATUSES.has(status) ? 'error' :
        SUCCESS_STATUSES.has(status) ? 'success' : null)
  }
  for (const field of ['statusCode', 'status_code']) {
    const code = response[field]
    if (Number.isInteger(code) && code >= 100 && code <= 599)
      add('http_status', field, code, code >= 400 ? 'error' : code >= 200 ? 'success' : null)
  }
  for (const field of ['success', 'ok']) {
    if (typeof response[field] === 'boolean')
      add('success_flag', field, response[field], response[field] ? 'success' : 'error')
  }
  if (response.error !== undefined && response.error !== null &&
      response.error !== false && response.error !== '')
    add('error_field', 'error', null, 'error')

  const hasError = verdicts.includes('error')
  const hasSuccess = verdicts.includes('success')
  if (hasError && hasSuccess) outcomeEvidence.push({ type: 'conflicting_verdicts' })
  if (outcomeEvidence.length === 0)
    outcomeEvidence.push({ type: 'response_without_verdict' })
  else if (!hasError && !hasSuccess)
    outcomeEvidence.push({ type: 'response_without_verdict' })
  return { outcome: hasError ? 'error' : hasSuccess ? 'success' : 'unknown',
    outcomeEvidence }
}

export function extractEvent(input, { includeContext = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  if (!VALID_EVENTS.has(input.hook_event_name)) return null
  if (!validId(input.session_id) || !validId(input.turn_id)) return null
  const sessionId = input.session_id
  const turnId = input.turn_id
  if (input.hook_event_name === 'Stop')
    return { kind: 'summary', sessionId, turnId }
  if (input.hook_event_name === 'SubagentStop') {
    if (!validId(input.agent_id)) return null
    const agentType = safeName(input.agent_type)
    return {
      kind: 'observation', sessionId, turnId,
      observation: {
        eventId: 'subagent:' + input.agent_id,
        kind: 'subagent',
        role: classifyRole(agentType, 'subagent'),
        actor: 'subagent:' + input.agent_id,
        toolName: 'subagent:' + agentType,
        outcome: 'unknown',
        evidenceCodes: ['unknown_outcome'],
        outcomeEvidence: [{ type: 'subagent_no_verdict' }],
        ...(includeContext ? { stepContext: summarizeStepContext({
          toolName: 'subagent:' + agentType, response: input.last_assistant_message,
        }) } : {}),
        ...(typeof input.last_assistant_message === 'string'
          ? { response: input.last_assistant_message } : {}),
      },
    }
  }
  if (!validId(input.tool_use_id)) return null
  const toolName = safeName(input.tool_name)
  const { outcome, outcomeEvidence } = classifyResponse(input.tool_response)
  return {
    kind: 'observation', sessionId, turnId,
    observation: {
      eventId: 'tool:' + input.tool_use_id,
      kind: 'tool',
      role: classifyRole(toolName, 'tool'),
      actor: 'unknown_agent',
      toolName,
      outcome,
      evidenceCodes: [outcome === 'error' ? 'tool_error'
        : outcome === 'success' ? 'no_hard_signal' : 'unknown_outcome'],
      outcomeEvidence,
      ...(includeContext ? { stepContext: summarizeStepContext({
        toolName, toolInput: input.tool_input, response: input.tool_response,
      }) } : {}),
      ...(outcome === 'unknown' && Object.hasOwn(input, 'tool_response')
        ? { response: input.tool_response } : {}),
    },
  }
}
