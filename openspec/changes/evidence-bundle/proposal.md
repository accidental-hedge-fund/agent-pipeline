## Why

A pipeline run today leaves traces scattered across GitHub comments, commit messages, local stage logs, and the pipeline's own label transitions. Reconstructing what happened — which harness ran which command, which review verdict blocked which fix round, what overrides were applied — requires stitching those fragments together manually. This friction shows up acutely during debugging (why did the run stall?), review (did the reviewer actually pass this?), and handoff (what did the pipeline actually do?).

SmallHarness treats sessions as inspectable artifacts, writing a per-run history file that makes this reconstruction instant. agent-pipeline already has richer GitHub issue/PR state, but it lacks a parallel local artifact. Adding one closes the inspection gap without displacing the authoritative GitHub state.

## What Changes

- **Evidence bundle writer** added as a cross-cutting module: initialized once per pipeline entry, updated incrementally by each stage, finalized when the run ends.
- **Bundle file** written to a stable, predictable path under the existing run/state directory for the issue. The file is machine-readable JSON.
- **Captured per bundle**: issue/PR identifiers, branch, run ID, harness identities, stage transitions (entry/exit time, outcome), commands executed (exit code, duration — no raw env values), review verdict summaries (round, SHA, verdict, finding counts by severity), override dispositions, recovery events, and the final pipeline state.
- **Human-readable summary** printable via a `--summary` flag (or equivalent) without parsing the raw JSON.
- **PR/issue notified** with a single comment or annotation recording the local artifact path so a maintainer can find it without searching the filesystem.
- **Audit supplement only**: the bundle records what happened; it does not drive label transitions or replace GitHub comments as the authoritative state source.

## Capabilities

### New Capabilities

- `evidence-bundle`: The per-run audit artifact — initialization, incremental stage-level updates, finalization, human-readable summary, and the PR/issue path notification. Defines the JSON schema, write semantics, sensitive-value exclusion rule, and the relationship to existing GitHub-facing state.

### Modified Capabilities

(none — no existing spec-level requirements change; stage modules and the orchestrator gain calls to the bundle writer, but their externally visible label-transition behaviour is unchanged)

## Acceptance Criteria

- [ ] Each pipeline run writes a JSON evidence bundle to a stable path under the issue's run/state directory.
- [ ] The bundle contains: issue number, PR number (if present), branch name, run ID, harness identity/identities, stage transitions (stage name, entry time, exit time, outcome), commands executed with exit code and duration, review verdict summaries (round, SHA, verdict, finding counts by severity), override dispositions (key, reason), recovery events, and the terminal pipeline state.
- [ ] Raw environment variable values are never present in the bundle.
- [ ] Running the pipeline with a `--summary <issue>` flag (or equivalent) prints a human-readable summary derived from the bundle.
- [ ] When a run finalizes, the PR/issue receives a comment or annotation recording the local artifact path.
- [ ] The bundle is an audit/debug supplement: removing or ignoring it has zero effect on label transitions, GitHub comments, or any other pipeline behavior.
- [ ] All existing tests continue to pass; new tests cover bundle initialization, per-stage update, finalization, summary output, and sensitive-value exclusion.

## Impact

- `core/scripts/evidence-bundle.ts` — new module: `EvidenceBundle` type, `createBundle()`, `recordStage()`, `recordCommand()`, `recordReview()`, `recordOverride()`, `recordRecovery()`, `finalizeBundle()`, `printSummary()`
- `core/scripts/types.ts` — `EvidenceBundle` and sub-types exported
- `core/scripts/pipeline.ts` — initializes bundle at run entry, threads it through dispatch, finalizes at exit, posts path comment
- `core/scripts/stages/*.ts` — each stage module calls `recordStage()` and `recordCommand()` at key points
- `core/scripts/stages/review.ts` — calls `recordReview()` after each verdict
- `core/scripts/stages/pre_merge.ts` — calls `recordOverride()` when overrides are applied
- `core/scripts/stages/auto_recover.ts` — calls `recordRecovery()` on each recovery event
- `core/test/evidence-bundle.test.ts` — new test file
