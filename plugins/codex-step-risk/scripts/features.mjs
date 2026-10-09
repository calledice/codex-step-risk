const FAILURE_STATUSES = new Set(['error', 'failed', 'failure'])
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

function hasStructuredError(response) {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return false
  if (response.isError === true || response.is_error === true) return true
  for (const key of ['exit_code', 'exitCode']) {
    if (typeof response[key] === 'number' && Number.isFinite(response[key]) && response[key] !== 0)
      return true
  }
  return typeof response.status === 'string' &&
    FAILURE_STATUSES.has(response.status.toLowerCase())
}

export function extractEvent(input) {
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
        evidenceCodes: ['no_hard_signal'],
      },
    }
  }
  if (!validId(input.tool_use_id)) return null
  const toolName = safeName(input.tool_name)
  return {
    kind: 'observation', sessionId, turnId,
    observation: {
      eventId: 'tool:' + input.tool_use_id,
      kind: 'tool',
      role: classifyRole(toolName, 'tool'),
      actor: 'unknown_agent',
      toolName,
      evidenceCodes: [hasStructuredError(input.tool_response) ? 'tool_error' : 'no_hard_signal'],
    },
  }
}
