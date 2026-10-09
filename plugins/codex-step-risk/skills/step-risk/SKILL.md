---
name: step-risk
description: Explain Codex Step Risk hook predictions and inspect its metadata-only JSONL when the user asks about suspicious tool or subagent events.
---

# Step Risk interpretation

When asked to inspect a Codex Step Risk prediction, read the JSONL path shown in the plugin's turn-summary message or supplied by the user. Read only that file; do not open Codex transcripts unless the user explicitly asks. If the log path is unavailable, ask for it.

Group records by `sessionId` and `turnId`. Show the highest `topCandidates` with `ordinal`, `eventId`, `role`, `actor`, `probability`, and supporting `evidenceCodes`. Explain that `pCurrent` is experimental uncalibrated model mass conditional on eventual failure and responsibility within the modeled observable/residual space. `pResidual` includes unobserved reasoning and future events.

Do not present a candidate as a proven cause. Ordinary tool events may have `actor=unknown_agent` because the hook event has no reliable agent ID. Use the original task and artifacts for a separate causal review only when the user requests it.
