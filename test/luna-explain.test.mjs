import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLunaEvidence, explainWithLuna } from '../plugins/codex-step-risk/scripts/luna-explain.mjs'

test('Luna input excludes local responses, identifiers, and free-form status text', () => {
  const result = buildLunaEvidence({
    sessionId: 'PRIVATE_SESSION', turnId: 'PRIVATE_TURN', eventId: 'PRIVATE_EVENT',
    toolName: 'PRIVATE_TOOL', response: { output: 'PRIVATE_RESPONSE' },
    kind: 'tool', role: 'executor', outcome: 'unknown',
    outcomeEvidence: [
      { type: 'status', field: 'status', value: 'PRIVATE_STATUS' },
      { type: 'exit_code', field: 'exit_code', value: 7 },
      { type: 'success_flag', field: 'ok', value: false },
      { type: 'response_without_verdict' },
    ],
    taskFailureRisk: { status: 'assumption_based_uncalibrated', value: 0.42 },
    pCurrent: 0.13, pResidual: 0.64,
  })
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'))
  assert.deepEqual(result.signals, [
    { type: 'status', value: 'other' },
    { type: 'exit_code', value: 7 },
    { type: 'success_flag', marker: 'ok', value: false },
    { type: 'response_without_verdict' },
  ])
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.taskRisk.value, 0.42)
})

test('Luna uses Responses structured output and returns explanation text only', async () => {
  let request
  const fetchImpl = async (url, options) => {
    request = { url, options }
    return {
      ok: true,
      json: async () => ({ status: 'completed', output: [{
        type: 'message', content: [{ type: 'output_text',
          text: JSON.stringify({ summary: '缺少判据', basis: ['没有退出码'], limits: '不能判断成功' }) }],
      }] }),
    }
  }
  const explanation = await explainWithLuna({ kind: 'tool', role: 'executor',
    outcome: 'unknown', signals: [], taskRisk: { status: 'unavailable', value: null },
    pCurrent: null, pResidual: null }, { apiKey: 'test-key',
    apiUrl: 'https://gateway.example/v1/responses', fetchImpl })
  assert.deepEqual(explanation, { summary: '缺少判据', basis: ['没有退出码'], limits: '不能判断成功' })
  assert.equal(request.url, 'https://gateway.example/v1/responses')
  const body = JSON.parse(request.options.body)
  assert.equal(body.model, 'gpt-6-luna')
  assert.equal(body.store, false)
  assert.equal(body.text.format.type, 'json_schema')
  assert.equal(body.text.format.strict, true)
  assert.equal(body.reasoning.effort, 'low')
})

test('Luna fails closed when unavailable or refusing', async () => {
  await assert.rejects(explainWithLuna({}, { apiKey: '' }), { code: 'not_configured' })
  await assert.rejects(explainWithLuna({}, { apiKey: 'test-key',
    fetchImpl: async () => ({ ok: true, json: async () => ({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }],
    }) }),
  }), { code: 'refused' })
})

function completedResponse() {
  return { ok: true, status: 200, json: async () => ({ status: 'completed', output: [{
    type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
      summary: '缺少判据', basis: ['没有退出码'], limits: '不能判断成功',
    }) }],
  }] }) }
}

test('Luna retries a transient gateway failure once and preserves the request', async () => {
  const requests = []
  const delays = []
  const result = await explainWithLuna({ outcome: 'unknown' }, {
    apiKey: 'test-key', sleepImpl: async ms => delays.push(ms),
    fetchImpl: async (url, options) => {
      requests.push({ url, body: options.body })
      return requests.length === 1 ? { ok: false, status: 502 } : completedResponse()
    },
  })
  assert.equal(result.summary, '缺少判据')
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[0], requests[1])
  assert.deepEqual(delays, [500])
})

test('Luna reports permanent authentication failures without retrying or exposing upstream text', async () => {
  let calls = 0
  await assert.rejects(explainWithLuna({}, {
    apiKey: 'test-key', sleepImpl: async () => assert.fail('must not retry'),
    fetchImpl: async () => { calls++; return { ok: false, status: 401,
      text: async () => 'PRIVATE_UPSTREAM_SECRET' } },
  }), error => {
    assert.equal(error.code, 'authentication_failed')
    assert.equal(error.upstreamStatus, 401)
    assert.equal(error.attempts, 1)
    assert.ok(!error.message.includes('PRIVATE_'))
    return true
  })
  assert.equal(calls, 1)
})

test('Luna retries a network interruption and bounds repeated timeouts to two attempts', async () => {
  let calls = 0
  await explainWithLuna({}, { apiKey: 'test-key', sleepImpl: async () => {},
    fetchImpl: async () => {
      if (++calls === 1) throw new TypeError('PRIVATE_NETWORK_DETAILS')
      return completedResponse()
    },
  })
  assert.equal(calls, 2)
  calls = 0
  await assert.rejects(explainWithLuna({}, { apiKey: 'test-key', sleepImpl: async () => {},
    fetchImpl: async () => { calls++; throw new DOMException('PRIVATE_TIMEOUT', 'TimeoutError') },
  }), error => {
    assert.equal(error.code, 'timeout')
    assert.equal(error.attempts, 2)
    assert.equal(error.retryable, true)
    assert.ok(!error.message.includes('PRIVATE_'))
    return true
  })
  assert.equal(calls, 2)
})

test('Luna distinguishes truncated output from an unavailable service without retrying', async () => {
  let calls = 0
  await assert.rejects(explainWithLuna({}, { apiKey: 'test-key',
    fetchImpl: async () => { calls++; return { ok: true, status: 200,
      json: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) } },
  }), error => {
    assert.equal(error.code, 'output_limit')
    assert.equal(error.attempts, 1)
    assert.equal(error.retryable, false)
    return true
  })
  assert.equal(calls, 1)
})

test('Luna stops after a second gateway error and does not retry rate limits or bad requests', async () => {
  for (const [status, code, attempts] of [[503, 'upstream_unavailable', 2],
    [429, 'rate_limited', 1], [400, 'request_rejected', 1]]) {
    let calls = 0
    await assert.rejects(explainWithLuna({}, { apiKey: 'test-key', sleepImpl: async () => {},
      fetchImpl: async () => { calls++; return { ok: false, status } },
    }), error => {
      assert.equal(error.code, code)
      assert.equal(error.upstreamStatus, status)
      assert.equal(error.attempts, attempts)
      return true
    })
    assert.equal(calls, attempts)
  }
})

test('Luna classifies malformed response shapes without mistaking them for network failures', async () => {
  for (const data of [null, { status: 'completed', output: {} },
    { status: 'completed', output: [null] },
    { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{' }] }] }]) {
    await assert.rejects(explainWithLuna({}, { apiKey: 'test-key',
      sleepImpl: async () => assert.fail('invalid formats must not trigger a network retry'),
      fetchImpl: async () => ({ ok: true, json: async () => data }),
    }), { code: 'invalid_response', attempts: 1 })
  }
})
