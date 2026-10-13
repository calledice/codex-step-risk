import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync,
  rmdirSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { initialState, observe, snapshotFor } from './model.mjs'
import { composePrediction } from './prediction.mjs'
import { nextRiskScore, riskEstimate } from './risk.mjs'
import { estimateStepFailure } from './step-probability.mjs'

const pause = new Int32Array(new SharedArrayBuffer(4))
const hash = value => createHash('sha256').update(value).digest('hex')

function withLock(path, action) {
  const deadline = Date.now() + 5000
  while (true) {
    try {
      mkdirSync(path)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(path).mtimeMs > 30000) rmdirSync(path)
      } catch (staleError) {
        if (staleError?.code !== 'ENOENT' && staleError?.code !== 'ENOTEMPTY')
          throw staleError
      }
      if (Date.now() > deadline) throw new Error('lock timeout')
      Atomics.wait(pause, 0, 0, 20)
    }
  }
  try {
    return action()
  } finally {
    rmdirSync(path)
  }
}

function writeAtomic(path, value) {
  const tempPath = path + '.' + process.pid + '.' + randomUUID() + '.tmp'
  writeFileSync(tempPath, JSON.stringify(value), 'utf8')
  renameSync(tempPath, path)
}

function readState(path, sessionId, turnId) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'))
    if (state.schemaVersion === 1 && state.sessionId === sessionId && state.turnId === turnId)
      return state
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  return initialState(sessionId, turnId)
}

function predictionFor(snapshot) {
  return composePrediction({
    currentEventId: snapshot.eventId,
    failureRisk: riskEstimate(snapshot.riskScore),
    conditionalOrigin: {
      status: 'experimental_uncalibrated',
      candidates: snapshot.topCandidates,
      residualWeight: snapshot.pResidual,
      otherWeight: Math.max(0, 1 - snapshot.pResidual -
        snapshot.topCandidates.reduce((sum, candidate) => sum + candidate.weight, 0)),
    },
  })
}

export function processTurn(dataDir, event) {
  const key = hash(event.sessionId + '\0' + event.turnId)
  const stateDir = join(dataDir, 'state')
  const eventDir = join(dataDir, 'events', key)
  const seenDir = join(dataDir, 'seen', key)
  const lockDir = join(dataDir, 'locks')
  const logDir = join(dataDir, 'logs')
  for (const dir of [stateDir, eventDir, seenDir, lockDir, logDir])
    mkdirSync(dir, { recursive: true })
  const statePath = join(stateDir, key + '.json')
  const logPath = join(logDir, key + '.jsonl')
  const lockPath = join(lockDir, key + '.lock')
  const eventPath = ordinal => join(eventDir, String(ordinal).padStart(12, '0') + '.json')
  const seenPath = id => join(seenDir, hash(id) + '.json')

  return withLock(lockPath, () => {
    let state = readState(statePath, event.sessionId, event.turnId)
    let recovered = false
    if (!Number.isFinite(state.riskScore)) {
      let score = 0
      for (let ordinal = 1; ordinal <= state.ordinal; ordinal += 1) {
        const committed = JSON.parse(readFileSync(eventPath(ordinal), 'utf8'))
        score = nextRiskScore(score, committed.observation?.outcome)
      }
      state.riskScore = score
      recovered = true
    }
    while (existsSync(eventPath(state.ordinal + 1))) {
      const observation = JSON.parse(readFileSync(eventPath(state.ordinal + 1), 'utf8')).observation
      const result = observe(state, observation)
      if (!result.snapshot) throw new Error('duplicate committed event')
      state = result.state
      if (!existsSync(seenPath(observation.eventId)))
        writeAtomic(seenPath(observation.eventId), { ordinal: state.ordinal })
      recovered = true
    }
    if (recovered) writeAtomic(statePath, state)

    if (event.kind === 'summary') {
      if (state.ordinal === 0) return { snapshot: null, logPath }
      const snapshot = snapshotFor(state)
      return { snapshot: { ...snapshot, ...predictionFor(snapshot) }, logPath }
    }

    const observation = event.observation
    if (existsSync(seenPath(observation.eventId)))
      return { snapshot: null, logPath }
    const ordinal = state.ordinal + 1
    writeAtomic(eventPath(ordinal), { schemaVersion: 2, observation })
    writeAtomic(seenPath(observation.eventId), { ordinal })
    const result = observe(state, observation)
    if (!result.snapshot) throw new Error('new event rejected as duplicate')
    const snapshot = {
      ...result.snapshot, ...predictionFor(result.snapshot),
      observedAt: new Date().toISOString(),
      stepFailure: estimateStepFailure(observation),
      ...(observation.stepContext ? { stepContext: observation.stepContext } : {}),
      ...(observation.operation ? { operation: observation.operation } : {}),
      ...(observation.outcome === 'unknown' && Object.hasOwn(observation, 'response')
        ? { response: observation.response } : {}),
    }
    writeAtomic(statePath, result.state)
    appendFileSync(logPath, JSON.stringify(snapshot) + '\n', 'utf8')
    return { snapshot, logPath }
  })
}
