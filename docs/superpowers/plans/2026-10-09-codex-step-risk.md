# Codex Step Risk Implementation Plan

> **For agentic workers:** This plan is executed inline in the current task. Steps use checkbox syntax for tracking.

**Goal:** Publish a GitHub-installable Codex plugin that updates an experimental attribution estimate after each observable tool result without replay or a fixed turn length.

**Architecture:** Codex hooks send structured events to a short-lived Node.js script. A pure bounded-state Bayesian filter updates one turn at a time; a locked state file survives hook process restarts. Plugin hooks display compact predictions and persist metadata-only JSONL.

**Tech Stack:** Codex portable plugin manifest, Codex lifecycle hooks, Node.js ESM, built-in node:test, GitHub marketplace.

## Global Constraints

- Target events: `PostToolUse`, `SubagentStop`, and `Stop`; internal model steps are not observable.
- `pCurrent` is conditional, turn-local, and `experimental_uncalibrated`.
- No replay, tool rewriting, raw message logging, or fixed maximum event count.
- All writes stay in `PLUGIN_DATA` except repository source files.
- Publish to `calledice/codex-step-risk`; do not alter the existing DeepSeek Harness repository.

---

## File map

- `plugins/codex-step-risk/plugin.json`: portable plugin identity and OpenAI hooks extension.
- `plugins/codex-step-risk/hooks/hooks.json`: lifecycle command hooks.
- `plugins/codex-step-risk/scripts/model.mjs`: bounded pure filter and snapshot.
- `plugins/codex-step-risk/scripts/features.mjs`: metadata-only event extraction.
- `plugins/codex-step-risk/scripts/hook.mjs`: stdin, locking, persistence, and hook response.
- `plugins/codex-step-risk/skills/step-risk/SKILL.md`: on-demand interpretation workflow.
- `.agents/plugins/marketplace.json`: repository marketplace.
- `test/*.test.mjs`: model, extraction, process, and packaging checks.
- `README.md` and `docs/*.md`: installation, semantics, verification.

### Task 1: Model

- [ ] Add failing tests for mass conservation, role prior, structured error likelihood, 10,000 events, candidate compression, and independent turns.
- [ ] Implement `initialState()` and `observe(state, observation)` in `scripts/model.mjs`. Keep positive normalized masses: `future`, `otherPast`, and bounded candidate weights. Apply recovery transition, role hazard, evidence ratio, normalization, then lowest-weight history compression.
- [ ] Run `node --test test/model.test.mjs` and confirm passing results.

### Task 2: Event extraction

- [ ] Add tests for `PostToolUse` hard errors, successful tools, and `SubagentStop` actor identity; include secret-bearing input/output text and assert it never appears in extracted data.
- [ ] Implement `extractObservation(input)` and `classifyRole(name, kind)` in `scripts/features.mjs` using only supported structured fields.
- [ ] Run `node --test test/features.test.mjs`.

### Task 3: Hook process and persistence

- [ ] Add process tests that send JSON to `hook.mjs` through stdin with temporary `PLUGIN_DATA`, then verify output, JSONL, idempotence, and concurrent updates.
- [ ] Implement file locking under `PLUGIN_DATA`, atomic state replacement, and metadata-only JSONL. `PostToolUse` and `SubagentStop` write an estimate; `Stop` reads summary. On internal failures, exit zero without changing tool behavior.
- [ ] Run `node --test test/hook.test.mjs`.

### Task 4: Package and publish

- [ ] Add portable `plugin.json`, `hooks/hooks.json`, marketplace entry, skill, README, model and validation docs.
- [ ] Run `node --test`, `node --check`, JSON parsing, and a Codex CLI marketplace smoke test where possible; document any hook trust or host limitation.
- [ ] Inspect exact staged files and credential scans, commit in the independent repository, push `main` and `v0.1.0`, and read back GitHub content.
