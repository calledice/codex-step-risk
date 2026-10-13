import test from 'node:test'
import assert from 'node:assert/strict'
import { assessWithLuna } from '../plugins/codex-step-risk/scripts/luna-assess.mjs'
import { buildAssessmentEvidence } from '../plugins/codex-step-risk/scripts/assessment-context.mjs'

const evidence = () => buildAssessmentEvidence({ kind: 'tool', role: 'executor', ordinal: 2,
  toolName: 'PRIVATE_TOOL', response: 'PRIVATE_RESPONSE', sessionId: 'PRIVATE_SESSION',
  outcome: 'error', outcomeEvidence: [{ type: 'exit_code', value: 7 }] },
[{ kind: 'tool', role: 'verifier', outcome: 'success', ordinal: 1 }],
{ goal: 'PRIVATE_GOAL', dataMode: 'structured' })
const valid = () => ({ factors: { problem: 0.8, persistence: 0.5, impact: 0.25 },
  evidenceQuality: 'medium', summary: '本步的未解决问题可能影响目标完成。',
  reasons: ['目标步骤报告退出码 7。'], limitations: ['缺少目标与动作上下文。'],
  evidenceRefs: ['target', 'previous-1'] })
const response = value => ({ ok: true, status: 200, json: async () => ({ status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }) })

test('Luna assessment multiplies validated factors and sends only approved evidence in the real body', async () => {
  let request
  const result = await assessWithLuna({ ...evidence(), extraSecret: 'PRIVATE_EXTRA' }, {
    apiKey: 'test-key', apiUrl: 'https://gateway.example/v1/responses',
    fetchImpl: async (url, options) => { request = { url, options }; return response(valid()) },
  })
  assert.equal(result.source, 'luna')
  assert.equal(result.status, 'model_estimate')
  assert.equal(result.value, 0.1)
  assert.deepEqual(result.factors, valid().factors)
  assert.deepEqual(result.evidenceRefs, ['target', 'previous-1'])
  assert.equal(request.url, 'https://gateway.example/v1/responses')
  const body = JSON.parse(request.options.body)
  assert.equal(body.model, 'gpt-6-luna')
  assert.equal(body.store, false)
  assert.equal(body.text.format.strict, true)
  assert.ok(!JSON.stringify(body.input).includes('PRIVATE_'))
  assert.match(body.input[0].content, /诊断/)
  assert.match(body.input[0].content, /不可信/)
  assert.match(body.input[0].content, /后续/)
})

test('Luna rejects out-of-range factors, invalid quality, empty wording and ungrounded references', async () => {
  const invalid = [
    { ...valid(), factors: { ...valid().factors, problem: 1.01 } },
    { ...valid(), factors: { ...valid().factors, persistence: '0.5' } },
    { ...valid(), factors: { ...valid().factors, impact: null } },
    { ...valid(), evidenceQuality: 'certain' },
    { ...valid(), evidenceRefs: [] },
    { ...valid(), evidenceRefs: ['previous-1'] },
    { ...valid(), evidenceRefs: ['target', 'future-1'] },
    { ...valid(), evidenceRefs: ['target', 'previous-2'] },
    { ...valid(), summary: '' },
    { ...valid(), summary: '\u0000' },
    { ...valid(), reasons: [''] },
    { ...valid(), limitations: 'none' },
  ]
  for (const value of invalid) {
    await assert.rejects(assessWithLuna(evidence(), { apiKey: 'test-key',
      sleepImpl: async () => assert.fail('validation errors must not retry'),
      fetchImpl: async () => response(value),
    }), { code: 'invalid_response' })
  }
})

test('context evidence in the actual request keeps useful summaries and removes hidden caller fields', async () => {
  let sent
  const context = buildAssessmentEvidence({ kind: 'tool', role: 'verifier',
    toolName: 'Bash', outcome: 'error', ordinal: 2,
    stepContext: { actionSummary: 'npm test --token=TOP_SECRET',
      responseSummary: 'A diagnostic test failed' },
  }, [], { dataMode: 'context_summary', goal: 'All tests pass; password=TOP_SECRET' })
  context.target.response = 'DO_NOT_SEND_RAW'
  context.target.eventId = 'DO_NOT_SEND_ID'
  await assessWithLuna(context, { apiKey: 'test-key', fetchImpl: async (_url, options) => {
    sent = JSON.parse(JSON.parse(options.body).input[1].content)
    return response({ ...valid(), evidenceRefs: ['target'] })
  } })
  assert.match(sent.goal, /All tests pass/)
  assert.match(sent.target.actionSummary, /npm test/)
  assert.equal(sent.target.responseSummary, 'A diagnostic test failed')
  assert.ok(!JSON.stringify(sent).includes('TOP_SECRET'))
  assert.ok(!JSON.stringify(sent).includes('DO_NOT_SEND'))
})

test('Luna preserves bounded text and valid references while filtering credentials in output', async () => {
  const value = { ...valid(), summary: 'x'.repeat(1000) + ' password=TOP_SECRET',
    reasons: Array.from({ length: 8 }, () => 'token=TOP_SECRET ' + 'r'.repeat(1000)),
    limitations: ['Authorization: Bearer TOP_SECRET'],
    evidenceRefs: ['target', 'target', 'previous-1'],
  }
  const result = await assessWithLuna(evidence(), { apiKey: 'test-key',
    fetchImpl: async () => response(value) })
  assert.ok(result.summary.length <= 400)
  assert.ok(result.reasons.length <= 4)
  assert.ok(result.reasons.every(item => item.length <= 300))
  assert.ok(!JSON.stringify(result).includes('TOP_SECRET'))
  assert.deepEqual(result.evidenceRefs, ['target', 'previous-1'])
})

test('Luna assessment reuses bounded transient retries and permanent safe errors', async () => {
  let calls = 0
  const result = await assessWithLuna(evidence(), { apiKey: 'test-key', sleepImpl: async () => {},
    fetchImpl: async () => ++calls === 1 ? { ok: false, status: 503 } : response(valid()) })
  assert.equal(calls, 2)
  assert.equal(result.value, 0.1)
  await assert.rejects(assessWithLuna(evidence(), { apiKey: 'test-key',
    fetchImpl: async () => ({ ok: false, status: 401 }),
    sleepImpl: async () => assert.fail('must not retry permanent errors'),
  }), { code: 'authentication_failed', attempts: 1 })
  await assert.rejects(assessWithLuna(evidence(), { apiKey: '' }), { code: 'not_configured' })
})
