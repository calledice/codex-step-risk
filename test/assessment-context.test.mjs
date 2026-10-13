import test from 'node:test'
import assert from 'node:assert/strict'
import { redactText, summarizeStepContext, buildAssessmentEvidence }
  from '../plugins/codex-step-risk/scripts/assessment-context.mjs'

test('context summaries remove credential fields and common textual secrets before truncation', () => {
  const secret = 'NEVER_SEND_THIS_VALUE'
  const text = [
    `Authorization: Bearer ${secret}`,
    `OPENAI_API_KEY='${secret}'`,
    `password: "${secret}"`,
    `curl --access-token ${secret} --password '${secret}'`,
    `https://user:${secret}@example.test/api?token=${secret}`,
    `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`,
    `sk-proj-${secret}`,
  ].join('\n')
  assert.ok(!redactText(text).includes(secret))
  assert.ok(!redactText({ nested: { access_token: secret, safe: 'exit 7' } }).includes(secret))
  const result = summarizeStepContext({ toolName: 'Bash',
    toolInput: { command: `npm test --password=${secret}`, token: secret },
    response: { output: text, password: secret, safe: 'diagnostic failed' },
  })
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.match(result.actionSummary, /npm test/)
  assert.ok(result.actionSummary.length <= 1200)
  assert.ok(result.responseSummary.length <= 2000)
  assert.ok(redactText('x'.repeat(1000), 80).length <= 80)
  assert.equal(redactText(redactText(text)), redactText(text))
})

test('redaction handles circular objects, truncated private keys and local path details', () => {
  const circular = { ok: 'test outcome' }
  circular.self = circular
  assert.match(redactText(circular), /test outcome/)
  assert.ok(!redactText('-----BEGIN RSA PRIVATE KEY-----\nNEVER_SEND').includes('NEVER_SEND'))
  assert.ok(!redactText('Read C:\\Users\\private-name\\project\\secret.txt').includes('private-name'))
})

const event = (ordinal, extra = {}) => ({ sessionId: 'PRIVATE_SESSION', turnId: 'PRIVATE_TURN',
  eventId: `PRIVATE_EVENT_${ordinal}`, ordinal, kind: 'tool', role: 'executor',
  toolName: 'PRIVATE_TOOL', outcome: 'unknown', operation: 'action',
  evidenceCodes: ['unknown_outcome', 'PRIVATE_EVIDENCE'],
  response: 'PRIVATE_RESPONSE', taskFailureRisk: { value: 0.99 }, pCurrent: 0.88, pResidual: 0.11,
  outcomeEvidence: [{ type: 'status', value: 'PRIVATE_STATUS' },
    { type: 'exit_code', field: 'exit_code', value: 7 }], ...extra })

test('structured evidence excludes all free text, legacy scores and identifiers', () => {
  const result = buildAssessmentEvidence(event(9), [event(7), event(8)],
    { goal: 'PRIVATE_GOAL', dataMode: 'structured' })
  const serialized = JSON.stringify(result)
  assert.ok(!serialized.includes('PRIVATE_'))
  for (const field of ['pCurrent', 'pResidual', 'taskRisk', 'taskFailureRisk', 'toolName',
    'response', 'goal', 'sessionId', 'eventId', 'turnId', 'ordinal'])
    assert.ok(!serialized.includes(`"${field}"`), field)
  assert.equal(result.target.ref, 'target')
  assert.equal(result.target.outcome, 'unknown')
  assert.equal(result.target.operation, 'action')
  assert.deepEqual(result.target.signals, [
    { type: 'status', value: 'other' }, { type: 'exit_code', value: 7 },
  ])
  assert.deepEqual(result.previous.map(item => item.ref), ['previous-1', 'previous-2'])
})

test('assessment uses at most six preceding same-turn observations and never future evidence', () => {
  const previous = Array.from({ length: 13 }, (_, n) => event(n + 1))
  previous.push(event(4, { turnId: 'OTHER_TURN' }))
  previous.push(event(5, { sessionId: 'OTHER_SESSION' }))
  const result = buildAssessmentEvidence(event(10), previous, { dataMode: 'structured' })
  assert.equal(result.previous.length, 6)
  assert.deepEqual(result.previous.map(item => item.ref),
    ['previous-1', 'previous-2', 'previous-3', 'previous-4', 'previous-5', 'previous-6'])
  const differentiated = buildAssessmentEvidence(event(3), [
    event(1, { outcome: 'success' }), event(2, { outcome: 'error' }), event(4),
  ])
  assert.deepEqual(differentiated.previous.map(item => item.outcome), ['success', 'error'])
})

test('context mode includes bounded redacted goal and available old or new summaries', () => {
  const result = buildAssessmentEvidence(event(2, {
    toolName: 'Bash', stepContext: { actionSummary: 'npm test --token=TOP_SECRET',
      responseSummary: '2 assertions failed' },
  }), [event(1, { response: 'inspection succeeded' })],
  { dataMode: 'context_summary', goal: 'Tests pass; password=TOP_SECRET' })
  assert.equal(result.dataMode, 'context_summary')
  assert.match(result.goal, /Tests pass/)
  assert.equal(result.target.toolName, 'Bash')
  assert.match(result.target.actionSummary, /npm test/)
  assert.equal(result.target.responseSummary, '2 assertions failed')
  assert.equal(result.previous[0].responseSummary, 'inspection succeeded')
  assert.ok(!JSON.stringify(result).includes('TOP_SECRET'))
  const defaultMode = buildAssessmentEvidence(event(1), [], { dataMode: 'unknown', goal: 'PRIVATE' })
  assert.equal(defaultMode.dataMode, 'structured')
  assert.ok(!JSON.stringify(defaultMode).includes('PRIVATE'))
})
