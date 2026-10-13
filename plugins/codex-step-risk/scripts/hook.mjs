import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { extractEvent } from './features.mjs'
import { processTurn } from './journal.mjs'
import { loadTaskSettings } from './assessment-store.mjs'

function display(value) {
  return String(value).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128)
}

function percent(value) {
  return (100 * value).toFixed(1) + '%'
}

function predictionMessage(snapshot) {
  const item = snapshot.kind === 'subagent' ? snapshot.actor : snapshot.toolName
  return '[codex-step-risk] event #' + snapshot.ordinal + ' ' + display(item) +
    ': observed outcome=' + snapshot.outcome +
    '; probability this step contributes to final task failure=' +
    percent(snapshot.stepFailure.value) + ' (model estimate, uncalibrated; source=rules)'
}

function summaryMessage(snapshot, logPath) {
  return '[codex-step-risk] turn summary: ' + snapshot.ordinal +
    ' observed steps; each step has an independent final-failure probability estimate.' +
    ' Turn end is not task completion. Log: ' + logPath
}

function run() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const dataDir = process.env.PLUGIN_DATA
  if (!dataDir || !isAbsolute(dataDir)) return {}
  const settings = loadTaskSettings(dataDir, input?.session_id)
  const event = extractEvent(input, { includeContext: settings.dataMode === 'context_summary' })
  if (!event) return {}
  const { snapshot, logPath } = processTurn(dataDir, event)
  if (!snapshot) return {}
  return { systemMessage: event.kind === 'summary'
    ? summaryMessage(snapshot, logPath) : predictionMessage(snapshot) }
}

try {
  process.stdout.write(JSON.stringify(run()) + '\n')
} catch {
  // Hook failures must not change Codex's tool result or turn outcome.
  process.stderr.write('[codex-step-risk] hook failed\n')
  process.stdout.write('{}\n')
}
