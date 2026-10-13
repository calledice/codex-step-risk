---
name: step-risk
description: Explain per-step final-task-failure probability estimates and inspect local Step Risk observations.
---

# Step Risk interpretation (0.4.1)

Inspect the local JSONL or dashboard session supplied by the user. Do not read full Codex transcripts automatically. A step is an observed tool completion or subagent completion; Stop ends a turn, not the task.

Explain `stepFailure.value` as the model estimate that this step leaves a relevant problem, the problem remains unresolved through task completion, and it materially contributes to failure of the session goal. It is the product of three conditional factors: problem, persistence given problem, and impact given persistent problem. Each step has its own possibly overlapping event. Percentages need not sum to 100% and are not importance or responsibility shares.

Show the probability, source (`rules` or `luna`), evidenceQuality, reasons, limitations, and original observed outcome separately. Both sources are model estimates without empirically verified accuracy. Local priors are success 1.2%, unknown 4.5%, known action error 21%, unknown-operation error 13.5%, and read/verification error 4.5%. Generic Bash does not establish action versus diagnosis. Luna can replace these priors using the task goal and bounded contemporaneous evidence; invalid or failed assessments leave the rules value in place.

The page settings define the session goal and data mode. Distributed defaults are structured-only and no automatic AI calls. Context-summary mode sends redacted bounded goal/action/response summaries and up to six preceding same-turn steps. Users can preview actual input. Do not upload complete logs, full transcripts, credentials or raw tool inputs. Unknown full responses may be stored locally; quote them only when necessary. Known outcomes store a redacted summary only when context collection was enabled.

Legacy records may have pCurrent, pResidual, taskFailureRisk and jointOriginFailure. They are compatibility data, not inputs to the new step probability. Never multiply or relabel those shares to produce a new probability. Missing old context cannot be reconstructed by invention. Bash stdout without exit code remains unknown even if its text says fail.

The dashboard preserves assessments in a local cache; goal/data changes invalidate them. Predictions use the prefix available at the step, not future results. A number is a model estimate, never proof of causation. The desktop browser panel is the display surface; hook systemMessage need not appear as a chat bubble.
