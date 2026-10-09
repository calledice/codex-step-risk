import test from 'node:test'
import assert from 'node:assert/strict'
import { initialState, observe } from '../plugins/codex-step-risk/scripts/model.mjs'

const event = (number, overrides = {}) => ({
  eventId: 'tool-' + number,
  kind: 'tool',
  role: 'executor',
  actor: 'unknown_agent',
  toolName: 'Bash',
  evidenceCodes: ['no_hard_signal'],
  ...overrides,
})

test('mass is conserved and residual remains explicit', () => {
  const first = observe(initialState('s1', 't1'), event(1))
  assert.equal(first.snapshot.ordinal, 1)
  assert.equal(first.snapshot.calibration, 'experimental_uncalibrated')
  assert.ok(Math.abs(first.snapshot.pRetained + first.snapshot.pOtherPast + first.snapshot.pResidual - 1) < 1e-12)
  assert.ok(first.snapshot.pCurrent > 0)
})

test('structured error increases current event weight and role changes hazard', () => {
  const base = observe(initialState('s', 't'), event(1)).snapshot
  const error = observe(initialState('s', 't'), event(1, { evidenceCodes: ['tool_error'] })).snapshot
  const planner = observe(initialState('s', 't'), event(1, { role: 'planner' })).snapshot
  assert.ok(error.pCurrent > base.pCurrent)
  assert.notEqual(planner.priorHazard, base.priorHazard)
})

test('arbitrarily long turn retains bounded candidates and promotes late errors', () => {
  let state = initialState('s', 't')
  for (let n = 1; n <= 10000; n += 1) state = observe(state, event(n)).state
  const result = observe(state, event(10001, { evidenceCodes: ['tool_error'] }))
  assert.equal(result.snapshot.ordinal, 10001)
  assert.ok(result.state.candidates.length <= 128)
  assert.ok(result.snapshot.pOtherPast > 0)
  assert.equal(result.snapshot.topCandidates[0].eventId, 'tool-10001')
  assert.ok(Math.abs(result.snapshot.pRetained + result.snapshot.pOtherPast + result.snapshot.pResidual - 1) < 1e-12)
})

test('duplicate ids are idempotent and turns are independent', () => {
  const one = observe(initialState('s', 't1'), event(1))
  const duplicate = observe(one.state, event(1))
  const other = observe(initialState('s', 't2'), event(1))
  assert.equal(duplicate.snapshot, null)
  assert.equal(duplicate.state.ordinal, 1)
  assert.equal(other.snapshot.ordinal, 1)
  assert.equal(other.snapshot.turnId, 't2')
})
