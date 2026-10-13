# Desktop Step Risk Panel Implementation Plan

> **For agentic workers:** Execute this plan inline in the current checkout. Existing uncommitted work must be preserved.

**Goal:** Show Step Risk's recorded per-step weights in a Codex desktop panel for the active session.

**Architecture:** A loopback-only Node server reads the existing metadata JSONL files and serves a read-only dashboard. The browser panel polls a bounded JSON API and displays the selected session and turn. The scoring hook and its output contract stay unchanged.

**Tech Stack:** Node.js 22.19+, built-in HTTP and filesystem modules, plain HTML/CSS/JavaScript.

## Global Constraints

- Show `taskFailureRisk` as unavailable; never label `pCurrent` as a failure probability.
- Read only Step Risk metadata logs. Do not load Codex transcripts or tool bodies.
- Bind to `127.0.0.1` and reject non-loopback Host headers.
- Preserve the current worktree changes and avoid new runtime dependencies.

---

### Task 1: Bounded metadata reader

**Files:** Create `plugins/codex-step-risk/scripts/dashboard-data.mjs`; test in `test/dashboard.test.mjs`.

**Interface:** `loadDashboard(dataDir, sessionId)` returns sanitized session and turn summaries; session IDs use a bounded safe identifier format or are empty. The reader ignores incomplete JSONL tails, skips oversized files, and limits the number of files and events returned.

- [x] Write a test fixture with two sessions, a malformed tail, and a marker field that must not appear in API data.
- [x] Run `node --test test/dashboard.test.mjs` and confirm the new test fails before implementation.
- [x] Implement the bounded reader and run the focused test again.

### Task 2: Read-only local API and dashboard

**Files:** Create `plugins/codex-step-risk/scripts/dashboard-server.mjs` and `plugins/codex-step-risk/assets/dashboard.html`, `dashboard.css`, `dashboard.js`; extend `test/dashboard.test.mjs`.

**Interface:** `startDashboard({ dataDir, port })` serves `/`, static assets, and `/api/dashboard?sessionId=<uuid>`. The UI uses `textContent`, shows the latest turn's events and top candidates, and refreshes every two seconds.

- [x] Add an HTTP test for a successful metadata response, invalid session ID, and a rejected external Host header.
- [x] Run the focused test and confirm failure before server implementation.
- [x] Implement the server and static UI; rerun focused tests.

### Task 3: Integration and live verification

**Files:** Modify `README.md` and `docs/VALIDATION.md` with launch and interpretation instructions.

- [x] Run `node --test`, `node --check` on new scripts, and `git diff --check`.
- [x] Launch the dashboard against this machine's Step Risk data, open it in the Codex panel for the current session, and verify the visible event list and unavailable probability label.
- [x] Record the exact live result and any remaining limitation in `docs/VALIDATION.md`.
