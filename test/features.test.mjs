import test from 'node:test'
import assert from 'node:assert/strict'
import { extractEvent } from '../plugins/codex-step-risk/scripts/features.mjs'

const common = { session_id: 'session', turn_id: 'turn', cwd: 'C:/secret' }

test('PostToolUse extracts only explicit error markers and metadata', () => {
  const value = extractEvent({
    ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_use_id: 'call-1',
    tool_input: { command: 'PRIVATE_PROMPT' },
    tool_response: { exit_code: 2, output: 'PRIVATE_RESULT', error: 'PRIVATE_ERROR' },
  })
  assert.deepEqual(value.observation.evidenceCodes, ['tool_error'])
  assert.equal(value.observation.actor, 'unknown_agent')
  assert.equal(value.observation.role, 'executor')
  assert.ok(!JSON.stringify(value).includes('PRIVATE_'))
})

test('successful tool with no structured error uses weak negative evidence', () => {
  const value = extractEvent({
    ...common, hook_event_name: 'PostToolUse', tool_name: 'update_plan',
    tool_use_id: 'call-2', tool_response: { exit_code: 0, output: 'error word' },
  })
  assert.equal(value.observation.role, 'planner')
  assert.equal(value.observation.outcome, 'success')
  assert.deepEqual(value.observation.evidenceCodes, ['no_hard_signal'])
})

test('missing structured outcome stays unknown rather than becoming success', () => {
  const response = { output: 'looks fine' }
  const value = extractEvent({
    ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_use_id: 'call-unknown', tool_response: response,
  })
  assert.equal(value.observation.outcome, 'unknown')
  assert.deepEqual(value.observation.evidenceCodes, ['unknown_outcome'])
  assert.deepEqual(value.observation.response, response)
  assert.ok(value.observation.outcomeEvidence.some(item => item.type === 'response_without_verdict'))
  assert.ok(!JSON.stringify(value.observation).includes('PRIVATE_PROMPT'))
})

test('plain-text Bash output does not reveal the terminal exit code', () => {
  const value = extractEvent({
    ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_use_id: 'call-text', tool_response: 'step-risk-fail\r\n',
  })
  assert.equal(value.observation.outcome, 'unknown')
  assert.deepEqual(value.observation.evidenceCodes, ['unknown_outcome'])
  assert.equal(value.observation.response, 'step-risk-fail\r\n')
  assert.ok(value.observation.outcomeEvidence.some(item => item.type === 'response_text_only'))
})

test('structured verdicts report their exact basis without scanning output text', () => {
  const cases = [
    [{ exit_code: 7, output: 'ok' }, 'error', 'exit_code'],
    [{ exitCode: 0, output: 'error' }, 'success', 'exit_code'],
    [{ isError: true, content: [{ type: 'text', text: 'ok' }] }, 'error', 'error_flag'],
    [{ is_error: false }, 'success', 'success_flag'],
    [{ status: 'timeout' }, 'error', 'status'],
    [{ status: 'pending' }, 'unknown', 'status'],
    [{ success: false }, 'error', 'success_flag'],
    [{ ok: true }, 'success', 'success_flag'],
    [{ statusCode: 503 }, 'error', 'http_status'],
    [{ status_code: 204 }, 'success', 'http_status'],
    [{ error: { code: 'ENOENT' } }, 'error', 'error_field'],
  ]
  for (const [response, expectedOutcome, evidenceType] of cases) {
    const value = extractEvent({
      ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_use_id: 'call-' + evidenceType, tool_response: response,
    }).observation
    assert.equal(value.outcome, expectedOutcome, JSON.stringify(response))
    assert.ok(value.outcomeEvidence.some(item => item.type === evidenceType),
      JSON.stringify(response))
    if (expectedOutcome !== 'unknown') assert.equal(value.response, undefined)
  }
})

test('explicit failure marker wins over a conflicting zero exit code', () => {
  const value = extractEvent({
    ...common, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_use_id: 'call-conflict',
    tool_response: { exit_code: 0, status: 'error' },
  })
  assert.equal(value.observation.outcome, 'error')
})

test('SubagentStop preserves agent identity without transcript content', () => {
  const value = extractEvent({
    ...common, hook_event_name: 'SubagentStop', agent_id: 'agent-7',
    agent_type: 'reviewer', last_assistant_message: 'PRIVATE_MESSAGE',
    agent_transcript_path: 'C:/PRIVATE_PATH',
  })
  assert.equal(value.observation.actor, 'subagent:agent-7')
  assert.equal(value.observation.role, 'verifier')
  assert.equal(value.observation.outcome, 'unknown')
  assert.equal(value.observation.response, 'PRIVATE_MESSAGE')
  assert.ok(value.observation.outcomeEvidence.some(item => item.type === 'subagent_no_verdict'))
  assert.ok(!JSON.stringify(value).includes('PRIVATE_PATH'))
})

test('Stop is a summary and unsupported events are ignored', () => {
  assert.equal(extractEvent({ ...common, hook_event_name: 'Stop' }).kind, 'summary')
  assert.equal(extractEvent({ ...common, hook_event_name: 'PreToolUse' }), null)
})
