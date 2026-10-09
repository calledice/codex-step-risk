import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync,
  rmdirSync, statSync, writeFileSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { extractEvent } from './features.mjs'
import { initialState, observe, snapshotFor } from './model.mjs'

const pause = new Int32Array(new SharedArrayBuffer(4))

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

function writeState(path, state) {
  const tempPath = path + '.' + process.pid + '.' + randomUUID() + '.tmp'
  writeFileSync(tempPath, JSON.stringify(state), 'utf8')
  renameSync(tempPath, path)
}

function display(value) {
  return String(value).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128)
}

function percent(value) {
  return (100 * value).toFixed(1) + '%'
}

function predictionMessage(snapshot) {
  const item = snapshot.kind === 'subagent' ? snapshot.actor : snapshot.toolName
  return '[codex-step-risk] event #' + snapshot.ordinal + ' ' + display(item) +
    ': current=' + percent(snapshot.pCurrent) +
    ', residual=' + percent(snapshot.pResidual) +
    ' (experimental_uncalibrated)'
}

function summaryMessage(snapshot, logPath) {
  const top = snapshot.topCandidates[0]
  const lead = top
    ? '#' + top.ordinal + ' ' + display(top.kind === 'subagent' ? top.actor : top.toolName) +
      ' ' + percent(top.probability)
    : 'none'
  return '[codex-step-risk] turn summary: top=' + lead +
    ', residual=' + percent(snapshot.pResidual) +
    ' (experimental_uncalibrated). Log: ' + logPath
}

function run() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const event = extractEvent(input)
  if (!event) return {}
  const dataDir = process.env.PLUGIN_DATA
  if (!dataDir || !isAbsolute(dataDir)) return {}
  mkdirSync(dataDir, { recursive: true })
  const stateDir = join(dataDir, 'state')
  const logDir = join(dataDir, 'logs')
  const lockDir = join(dataDir, 'locks')
  for (const dir of [stateDir, logDir, lockDir]) mkdirSync(dir, { recursive: true })
  const key = createHash('sha256').update(event.sessionId).digest('hex')
  const statePath = join(stateDir, key + '.json')
  const logPath = join(logDir, key + '.jsonl')
  const lockPath = join(lockDir, key + '.lock')
  return withLock(lockPath, () => {
    let state = existsSync(statePath)
      ? JSON.parse(readFileSync(statePath, 'utf8'))
      : initialState(event.sessionId, event.turnId)
    if (state.sessionId !== event.sessionId || state.turnId !== event.turnId)
      state = initialState(event.sessionId, event.turnId)
    if (event.kind === 'summary') {
      if (state.ordinal === 0) return {}
      const snapshot = snapshotFor(state)
      return { systemMessage: summaryMessage(snapshot, logPath) }
    }
    const result = observe(state, event.observation)
    if (!result.snapshot) return {}
    writeState(statePath, result.state)
    appendFileSync(logPath, JSON.stringify(result.snapshot) + '\n', 'utf8')
    return { systemMessage: predictionMessage(result.snapshot) }
  })
}

try {
  process.stdout.write(JSON.stringify(run()) + '\n')
} catch {
  // Hook failures must not change Codex's tool result or turn outcome.
  process.stderr.write('[codex-step-risk] hook failed\n')
  process.stdout.write('{}\n')
}
