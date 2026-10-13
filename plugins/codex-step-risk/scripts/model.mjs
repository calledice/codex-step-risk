import { nextRiskScore } from './risk.mjs'

export const MODEL_VERSION = '0.4.1'
export const CALIBRATION = 'experimental_uncalibrated'
export const SCOPE = 'conditional_on_eventual_failure_and_observable_turn_responsibility'

export const DEFAULT_CONFIG = Object.freeze({
  baseHazard: 0.03,
  recoveryHazard: 0.02,
  maxCandidates: 128,
  topK: 3,
  roleOffsets: Object.freeze({ planner: 0.15, executor: 0.2, verifier: 0, other: 0 }),
  likelihoodRatios: Object.freeze({ no_hard_signal: 0.25, tool_error: 8, unknown_outcome: 1 }),
})

const ROLES = new Set(Object.keys(DEFAULT_CONFIG.roleOffsets))
const EVIDENCE = new Set(Object.keys(DEFAULT_CONFIG.likelihoodRatios))

function requireId(name, value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512)
    throw new TypeError(name + ' must be a non-empty string up to 512 characters')
}

function validateConfig(config) {
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    throw new TypeError('config must be an object')
  if (!(config.baseHazard > 0 && config.baseHazard < 1))
    throw new RangeError('baseHazard must be in (0, 1)')
  if (!(config.recoveryHazard > 0 && config.recoveryHazard < 1))
    throw new RangeError('recoveryHazard must be in (0, 1)')
  if (!Number.isSafeInteger(config.maxCandidates) || config.maxCandidates < 1)
    throw new RangeError('maxCandidates must be positive')
  if (!Number.isSafeInteger(config.topK) || config.topK < 1 || config.topK > config.maxCandidates)
    throw new RangeError('topK must be in [1, maxCandidates]')
  for (const role of ROLES)
    if (!Number.isFinite(config.roleOffsets?.[role]))
      throw new TypeError('invalid role offset: ' + role)
  for (const code of EVIDENCE)
    if (!(config.likelihoodRatios?.[code] > 0) || !Number.isFinite(config.likelihoodRatios[code]))
      throw new TypeError('invalid likelihood ratio: ' + code)
}

function validateObservation(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('observation must be an object')
  requireId('eventId', value.eventId)
  if (value.kind !== 'tool' && value.kind !== 'subagent') throw new RangeError('unknown kind')
  if (!ROLES.has(value.role)) throw new RangeError('unknown role')
  if (typeof value.actor !== 'string' || value.actor.length === 0) throw new TypeError('actor required')
  if (typeof value.toolName !== 'string') throw new TypeError('toolName must be a string')
  if (value.outcome !== undefined && !['error', 'success', 'unknown'].includes(value.outcome))
    throw new RangeError('unknown outcome')
  if (!Array.isArray(value.evidenceCodes) || value.evidenceCodes.length === 0)
    throw new TypeError('evidenceCodes must be non-empty')
  for (const code of value.evidenceCodes)
    if (!EVIDENCE.has(code)) throw new RangeError('unknown evidence code')
}

function hazardFor(role, config) {
  const base = Math.log(config.baseHazard / (1 - config.baseHazard))
  const logit = Math.max(-30, Math.min(30, base + config.roleOffsets[role]))
  return 1 / (1 + Math.exp(-logit))
}

export function initialState(sessionId, turnId) {
  requireId('sessionId', sessionId)
  requireId('turnId', turnId)
  return {
    schemaVersion: 1, sessionId, turnId, ordinal: 0,
    future: 1, otherPast: 0, candidates: [], recentIds: [], riskScore: 0,
  }
}

export function snapshotFor(state, current = null, config = DEFAULT_CONFIG) {
  validateConfig(config)
  const pRetained = state.candidates.reduce((sum, candidate) => sum + candidate.weight, 0)
  const topCandidates = [...state.candidates]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, config.topK)
    .map(({ ordinal, eventId, kind, role, actor, toolName, weight }) =>
      ({ ordinal, eventId, kind, role, actor, toolName, weight }))
  return {
    modelVersion: MODEL_VERSION, calibration: CALIBRATION, scope: SCOPE,
    sessionId: state.sessionId, turnId: state.turnId, ordinal: state.ordinal,
    eventId: current?.eventId ?? null, kind: current?.kind ?? 'summary',
    role: current?.role ?? null, actor: current?.actor ?? null,
    toolName: current?.toolName ?? null,
    outcome: current?.outcome ?? null,
    evidenceCodes: current ? [...current.evidenceCodes] : [],
    priorHazard: current?.priorHazard ?? null,
    pCurrent: current?.weight ?? null,
    pCurrentGivenNoEarlier: current
      ? current.weight / (current.weight + state.future) : null,
    pRetained, pOtherPast: state.otherPast, pResidual: state.future,
    riskScore: state.riskScore ?? 0,
    outcomeEvidence: current?.outcomeEvidence ?? [],
    retainedCandidates: state.candidates.length, topCandidates,
  }
}

export function observe(previous, observation, config = DEFAULT_CONFIG) {
  validateConfig(config)
  validateObservation(observation)
  if (previous.schemaVersion !== 1) throw new RangeError('unsupported state schema')
  if (previous.recentIds.includes(observation.eventId))
    return { state: previous, snapshot: null }
  const state = {
    ...previous,
    candidates: previous.candidates.map(candidate => ({ ...candidate })),
    recentIds: [...previous.recentIds, observation.eventId].slice(-256),
    riskScore: nextRiskScore(previous.riskScore, observation.outcome),
  }
  const survival = 1 - config.recoveryHazard
  const past = state.otherPast +
    state.candidates.reduce((sum, candidate) => sum + candidate.weight, 0)
  state.future += past * config.recoveryHazard
  state.otherPast *= survival
  for (const candidate of state.candidates) candidate.weight *= survival
  const priorHazard = hazardFor(observation.role, config)
  const evidenceCodes = [...new Set(observation.evidenceCodes)]
  const ratio = evidenceCodes.reduce((value, code) =>
    value * config.likelihoodRatios[code], 1)
  const current = {
    ordinal: state.ordinal + 1, eventId: observation.eventId,
    kind: observation.kind, role: observation.role, actor: observation.actor,
    toolName: observation.toolName, outcome: observation.outcome ?? 'unknown',
    evidenceCodes, priorHazard,
    outcomeEvidence: observation.outcomeEvidence ?? [],
    weight: state.future * priorHazard * ratio,
  }
  state.future *= 1 - priorHazard
  state.candidates.push(current)
  const total = state.future + state.otherPast +
    state.candidates.reduce((sum, candidate) => sum + candidate.weight, 0)
  if (!Number.isFinite(total) || total <= 0) throw new RangeError('invalid posterior mass')
  state.future /= total
  state.otherPast /= total
  for (const candidate of state.candidates) candidate.weight /= total
  state.ordinal += 1
  if (state.candidates.length > config.maxCandidates) {
    let smallest = 0
    for (let i = 1; i < state.candidates.length - 1; i += 1)
      if (state.candidates[i].weight < state.candidates[smallest].weight) smallest = i
    const [removed] = state.candidates.splice(smallest, 1)
    state.otherPast += removed.weight
  }
  return { state, snapshot: snapshotFor(state, current, config) }
}
