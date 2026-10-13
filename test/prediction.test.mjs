import test from 'node:test'
import assert from 'node:assert/strict'
import { composePrediction } from '../plugins/codex-step-risk/scripts/prediction.mjs'

test('unavailable task risk never becomes a numeric joint probability', () => {
  const result = composePrediction({
    failureRisk: { status: 'unavailable_no_success_data', value: null },
    conditionalOrigin: {
      status: 'experimental_uncalibrated',
      candidates: [{ eventId: 'e1', weight: 0.2 }], residualWeight: 0.8,
    },
  })
  assert.equal(result.taskFailureRisk.value, null)
  assert.equal(result.jointOriginFailure.value, null)
  assert.equal(result.jointOriginFailure.candidates[0].value, null)
})

test('uncalibrated model risk is visible but never creates a joint attribution probability', () => {
  const result = composePrediction({
    currentEventId: 'e1',
    failureRisk: { status: 'assumption_based_uncalibrated', value: 0.6,
      baseline: 0.2, score: 2, modelVersion: 'fixed-signal-v1' },
    conditionalOrigin: {
      status: 'experimental_uncalibrated',
      candidates: [{ eventId: 'e1', weight: 0.2 }],
      residualWeight: 0.8, otherWeight: 0,
    },
  })
  assert.equal(result.taskFailureRisk.value, 0.6)
  assert.equal(result.taskFailureRisk.status, 'assumption_based_uncalibrated')
  assert.equal(result.jointOriginFailure.value, null)
})

test('joint values are emitted only when both components are calibrated', () => {
  const result = composePrediction({
    currentEventId: 'e1',
    failureRisk: { status: 'calibrated', value: 0.4 },
    conditionalOrigin: {
      status: 'calibrated', candidates: [{ eventId: 'e1', weight: 0.25 }],
      residualWeight: 0.75, otherWeight: 0,
    },
  })
  assert.equal(result.jointOriginFailure.status, 'calibrated')
  assert.equal(result.jointOriginFailure.value, 0.1)
  assert.equal(result.jointOriginFailure.candidates[0].value, 0.1)
  assert.ok(Math.abs(result.jointOriginFailure.residualValue - 0.3) < 1e-12)
})

test('an incomplete origin distribution cannot produce joint probabilities', () => {
  const result = composePrediction({
    failureRisk: { status: 'calibrated', value: 0.4 },
    conditionalOrigin: {
      status: 'calibrated', candidates: [{ eventId: 'e1', weight: 0.25 }],
      residualWeight: 0.5, otherWeight: 0,
    },
  })
  assert.equal(result.jointOriginFailure.value, null)
  assert.equal(result.jointOriginFailure.status, 'unavailable_uncalibrated_components')
  assert.equal(result.conditionalOrigin.status, 'invalid_calibration')
})

test('invalid calibrated task risk is never labelled calibrated', () => {
  const result = composePrediction({
    failureRisk: { status: 'calibrated', value: 1.5 },
    conditionalOrigin: {
      status: 'calibrated', candidates: [], residualWeight: 1, otherWeight: 0,
    },
  })
  assert.equal(result.taskFailureRisk.value, null)
  assert.equal(result.taskFailureRisk.status, 'invalid_calibration')
})
