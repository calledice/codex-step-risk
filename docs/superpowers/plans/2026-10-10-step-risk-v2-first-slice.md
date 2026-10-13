# Step Risk v2 First Slice Implementation Plan

**Implementation status (2026-10-10):** The live plugin portions of Tasks 1–3
are implemented in 0.2.0, with normalization kept in `features.mjs` and the
storage entry point named `processTurn`. Task 4, the offline evaluator, is
deferred until outcome data are collected. Real Codex host installation and
latency checks remain outstanding; see `docs/VALIDATION.md`.

**Goal:** Ship reliable per-boundary evidence capture and an honest prediction contract before adding calibrated numeric failure risk.

**Architecture:** A Codex hook adapter normalizes only observable events, then writes an idempotent per-turn journal. A scorer derives an experimental responsibility ranking from that journal; a composer returns task-risk and joint-probability fields as unavailable until matched success and failure data have passed calibration. The hook runs locally without contacting the annotation service.

**Tech Stack:** JavaScript ES modules, Node.js `>=22.19.0`, built-in `node:test`, Codex command hooks.

**Data gate:** The current review corpus has no successful tasks. This slice
must output `null` for task-failure and joint-origin probabilities. A later
calibration release requires consecutive Codex tasks with verified terminal
success and failure outcomes from the same observation contract. GFA failures
may inform label mapping and offline ranking experiments only.

## Global Constraints

- Keep prompt text, tool arguments, response bodies, and transcripts out of persisted events.
- Never display an uncalibrated score as task-failure risk or joint causal probability.
- Identify state by both `sessionId` and `turnId`; preserve late events for older turns.
- Preserve hook exit behavior: a plugin error must not block Codex tool execution.
- Keep model training and remote review-service calls off the live hook path.
- Treat `Stop` as a turn boundary, not a success label. Obtain terminal task
  outcomes from a separate outcome-collection path.

---

### Task 1: Normalize observed events and evidence quality

**Files:**
- Create: `plugins/codex-step-risk/scripts/event-contract.mjs`
- Modify: `plugins/codex-step-risk/scripts/features.mjs`
- Test: `test/features.test.mjs`

**Interfaces:**
- Consume the existing Codex hook JSON object.
- Produce `null` or an event with `sessionId`, `turnId`, `eventId`, `kind`, `role`, `actor`, `toolName`, `outcome`, and `evidenceQuality`.
- `outcome` is exactly `error`, `success`, or `unknown`; absent or unrecognized `tool_response` yields `unknown`.

- [ ] **Step 1: Add failing tests for missing and known outcomes.**

```js
const missing = extractEvent({
  hook_event_name: 'PostToolUse', session_id: 's', turn_id: 't',
  tool_use_id: 'e1', tool_name: 'exec_command',
})
assert.equal(missing.observation.outcome, 'unknown')
const failed = extractEvent({
  hook_event_name: 'PostToolUse', session_id: 's', turn_id: 't',
  tool_use_id: 'e2', tool_name: 'exec_command',
  tool_response: { exit_code: 1 },
})
assert.equal(failed.observation.outcome, 'error')
```

- [ ] **Step 2: Run `node --test test/features.test.mjs` and observe the new assertions fail.**
- [ ] **Step 3: Add a frozen outcome vocabulary and update `extractEvent`.** The `SubagentStop` outcome is `unknown` unless the host provides a structured outcome field. Keep raw payload fields out of the returned event.
- [ ] **Step 4: Run `node --test test/features.test.mjs`; expect every feature test to pass.**
- [ ] **Step 5: Review the diff for accidental raw-input persistence.**

### Task 2: Make turn storage idempotent and recoverable

**Files:**
- Create: `plugins/codex-step-risk/scripts/journal.mjs`
- Modify: `plugins/codex-step-risk/scripts/hook.mjs`
- Test: `test/hook.test.mjs`

**Interfaces:**
- Export `recordEvent(dataDir, event)`, returning `{ appended, ordinal, state }`.
- Store each event under a hash of `sessionId + '\0' + turnId`; never use session ID alone for mutable state.
- Under a per-turn lock, persist a complete event record to a temporary file and atomically rename it to its final event-ID path. Treat an existing event-ID path as a duplicate. Update a cached snapshot incrementally; replay only committed events beyond its last ordinal after an interrupted write. Temporary files do not count as events.

- [ ] **Step 1: Add a failing integration test for interleaved turns.**

```js
run(dir, { ...common, turn_id: 't1', tool_use_id: 'a' })
run(dir, { ...common, turn_id: 't2', tool_use_id: 'b' })
run(dir, { ...common, turn_id: 't1', tool_use_id: 'c' })
const summary = run(dir, { ...common, turn_id: 't2', hook_event_name: 'Stop' })
assert.match(JSON.parse(summary.stdout).systemMessage, /summary/)
```

- [ ] **Step 2: Run `node --test test/hook.test.mjs`; expect the interleaved-turn test to fail against v1.**
- [ ] **Step 3: Implement `recordEvent` and replace the session-scoped state path in `hook.mjs`.** Assign the next ordinal while holding the per-turn lock. Recover by replaying committed event files only when the derived state file is absent or behind the journal; use incremental state updates otherwise.
- [ ] **Step 4: Test a retry after an interrupted derived-state write.** Assert that the committed event is present exactly once and the next `Stop` still produces a summary.
- [ ] **Step 5: Run `node --test test/hook.test.mjs`; expect sequential, duplicate, concurrent, interleaved, and recovery cases to pass.**

### Task 3: Separate experimental ranking from calibrated probabilities

**Files:**
- Create: `plugins/codex-step-risk/scripts/prediction.mjs`
- Modify: `plugins/codex-step-risk/scripts/hook.mjs`
- Modify: `plugins/codex-step-risk/scripts/model.mjs`
- Test: `test/prediction.test.mjs`

**Interfaces:**
- Export `composePrediction({ failureRisk, conditionalOrigin })`.
- Return `taskFailureRisk`, `conditionalOrigin`, and `jointOriginFailure` with explicit `status` and `modelVersion` fields.
- Until calibrated failure-risk artifacts exist, `taskFailureRisk.value` and every `jointOriginFailure.value` are `null`. The current model's ranking may appear only as `conditionalOrigin.status = 'experimental_uncalibrated'`.

- [ ] **Step 1: Add a failing test for the no-success-data state.**

```js
const result = composePrediction({
  failureRisk: { status: 'unavailable', value: null },
  conditionalOrigin: { status: 'experimental_uncalibrated', candidates: [{ eventId: 'e1', weight: 0.2 }] },
})
assert.equal(result.taskFailureRisk.value, null)
assert.equal(result.jointOriginFailure[0].value, null)
```

- [ ] **Step 2: Run `node --test test/prediction.test.mjs`; expect the missing module to fail.**
- [ ] **Step 3: Implement the composer.** Multiply only when both component statuses are `calibrated` and both values are finite numbers in `[0, 1]`; otherwise return `null` with a reason code.
- [ ] **Step 4: Update the hook message to say `task failure risk: unavailable` and label the existing ranking as experimental.** Keep a stable JSON snapshot for later offline evaluation.
- [ ] **Step 5: Run `node --test`; expect all existing and new tests to pass.**

### Task 4: Add an offline evaluation contract

**Files:**
- Create: `tools/evaluate.mjs`
- Create: `test/evaluate.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Read local JSONL containing `taskId`, `outcome`, `events`, and optional `originEventIds` or `decisiveEventIds`.
- Group every prefix of a task into the same split. Reject a numeric failure-risk calibration report when a split lacks either successes or failures.
- Emit aggregate metrics only; do not copy trajectory text into the repository.

- [ ] **Step 1: Add a synthetic fixture with one success and one failure, plus a failing test that splitting never separates prefixes of the same `taskId`.**
- [ ] **Step 2: Run `node --test test/evaluate.test.mjs`; expect failure before implementation.**
- [ ] **Step 3: Implement schema validation, task-grouped splitting, and the class-presence gate.** Report class counts and visible-label coverage before any metric.
- [ ] **Step 4: Run `node --test` and `node --check tools/evaluate.mjs`; expect all checks to pass.**
- [ ] **Step 5: Document the JSONL contract and the data gate in `README.md`.**

## Completion check

Re-run `node --test`, verify the original interleaved-turn reproduction now returns a summary, and inspect a real Codex hook session for event schema, message wording, privacy, and added p50/p95 latency. Numeric task-failure and joint-origin probabilities remain unavailable until a later, separately evaluated calibration release has representative successful Codex tasks.
