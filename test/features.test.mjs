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
  assert.deepEqual(value.observation.evidenceCodes, ['no_hard_signal'])
})

test('SubagentStop preserves agent identity without transcript content', () => {
  const value = extractEvent({
    ...common, hook_event_name: 'SubagentStop', agent_id: 'agent-7',
    agent_type: 'reviewer', last_assistant_message: 'PRIVATE_MESSAGE',
    agent_transcript_path: 'C:/PRIVATE_PATH',
  })
  assert.equal(value.observation.actor, 'subagent:agent-7')
  assert.equal(value.observation.role, 'verifier')
  assert.ok(!JSON.stringify(value).includes('PRIVATE_'))
})

test('Stop is a summary and unsupported events are ignored', () => {
  assert.equal(extractEvent({ ...common, hook_event_name: 'Stop' }).kind, 'summary')
  assert.equal(extractEvent({ ...common, hook_event_name: 'PreToolUse' }), null)
})
