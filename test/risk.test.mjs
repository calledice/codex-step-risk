import test from 'node:test'
import assert from 'node:assert/strict'
import { nextRiskScore, riskEstimate } from '../plugins/codex-step-risk/scripts/risk.mjs'

test('assumption-based task risk starts from a declared prior and uses only verdicts', () => {
  const baseline = riskEstimate(0)
  assert.equal(baseline.status, 'assumption_based_uncalibrated')
  assert.equal(baseline.value, 0.2)
  const error = nextRiskScore(0, 'error')
  assert.ok(riskEstimate(error).value > baseline.value)
  assert.equal(nextRiskScore(error, 'unknown'), error)
  let recovered = error
  for (let n = 0; n < 4; n += 1) recovered = nextRiskScore(recovered, 'success')
  assert.equal(riskEstimate(recovered).value, baseline.value)
  assert.equal(nextRiskScore(0, 'success'), 0)
})

test('repeated error signals remain bounded without claiming certainty', () => {
  let score = 0
  for (let n = 0; n < 100; n += 1) score = nextRiskScore(score, 'error')
  assert.ok(riskEstimate(score).value < 1)
  assert.equal(riskEstimate(score).score, 3)
})
