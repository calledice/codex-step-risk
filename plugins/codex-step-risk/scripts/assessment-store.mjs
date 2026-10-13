import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeStepFailure, STEP_FAILURE_MODEL_VERSION } from './step-probability.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const DEFAULT_SETTINGS = Object.freeze({ goal: '', dataMode: 'structured', autoAssess: false })
const validId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)

function readJson(path, maxBytes = 65536) {
  try {
    if (statSync(path).size > maxBytes) return null
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

function writeJson(dir, name, value) {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  const temp = path + '.' + randomUUID() + '.tmp'
  writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
  renameSync(temp, path)
}

export function validTaskSettings(input) {
  return input && typeof input === 'object' && !Array.isArray(input) &&
    validId(input.sessionId) && typeof input.goal === 'string' && input.goal.length <= 2000 &&
    ['structured', 'context_summary'].includes(input.dataMode) && typeof input.autoAssess === 'boolean'
}

export function loadTaskSettings(dataDir, sessionId) {
  const defaults = readJson(join(dataDir, 'assessment-defaults.json'), 16384)
  const baseline = { ...DEFAULT_SETTINGS,
    ...(defaults?.dataMode === 'context_summary' ? { dataMode: 'context_summary' } : {}),
    ...(typeof defaults?.autoAssess === 'boolean' ? { autoAssess: defaults.autoAssess } : {}),
  }
  if (!validId(sessionId)) return baseline
  const stored = readJson(join(dataDir, 'task-settings', hash(sessionId) + '.json'), 16384)
  if (!validTaskSettings({ ...stored, sessionId })) return baseline
  return { goal: stored.goal, dataMode: stored.dataMode, autoAssess: stored.autoAssess }
}

export function saveTaskSettings(dataDir, input) {
  if (!validTaskSettings(input)) throw new TypeError('Invalid task settings')
  const settings = { goal: input.goal.trim(), dataMode: input.dataMode, autoAssess: input.autoAssess }
  writeJson(join(dataDir, 'task-settings'), hash(input.sessionId) + '.json', settings)
  return settings
}

export function assessmentFingerprint(evidence, settings, provider = {}) {
  return hash(JSON.stringify({ version: 'luna-step-assessment-v3', evidence,
    goal: settings.goal, dataMode: settings.dataMode,
    provider: provider.provider, endpoint: provider.apiUrl }))
}

function cacheKey(event) {
  if (!validId(event.sessionId) || !validId(event.turnId) ||
      !Number.isSafeInteger(event.ordinal) || event.ordinal < 1) throw new TypeError('Invalid event identity')
  return hash(JSON.stringify([event.sessionId, event.turnId, event.ordinal])) + '.json'
}

export function validatedAssessment(value) {
  if (!value || value.source !== 'luna' || value.modelVersion !== STEP_FAILURE_MODEL_VERSION ||
      value.status !== 'model_estimate' || typeof value.summary !== 'string' || value.summary.length > 600 ||
      !['reasons', 'limitations', 'evidenceRefs'].every(key => Array.isArray(value[key]) &&
        value[key].length <= 12 && value[key].every(item => typeof item === 'string' && item.length <= 600)) ||
      !value.evidenceRefs.includes('target')) throw new TypeError('Invalid stored assessment')
  const result = composeStepFailure(value.factors, value)
  if (typeof value.value !== 'number' || Math.abs(result.value - value.value) > 1e-12)
    throw new TypeError('Invalid probability product')
  return result
}

export function readAssessment(dataDir, event, fingerprint) {
  const cached = readJson(join(dataDir, 'assessments', cacheKey(event)))
  if (!cached || cached.schemaVersion !== 1 || cached.fingerprint !== fingerprint) return null
  try {
    return { ...validatedAssessment(cached.assessment), assessedAt: cached.assessedAt }
  } catch { return null }
}

export function writeAssessment(dataDir, event, fingerprint, assessment) {
  const clean = validatedAssessment(assessment)
  const assessedAt = new Date().toISOString()
  writeJson(join(dataDir, 'assessments'), cacheKey(event), {
    schemaVersion: 1, fingerprint, assessedAt, assessment: clean,
  })
  return { ...clean, assessedAt }
}
