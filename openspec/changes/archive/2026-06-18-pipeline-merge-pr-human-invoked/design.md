## Context

The pipeline already has human-only sub-commands peer to the advance loop — `release`, `intake`, `sweep` — each dispatched from `pipeline.ts` and implemented in their own module. `pipeline merge` follows the same pattern. The autonomous `advance` loop must remain structurally merge-free; the new command is a human-only surface available to the operator (directly or via a pipeline-desk button click).

Key constraints:
- `gh` field shapes must be verified before coding against them (CLAUDE.md rule #5).
- All merge I/O must be behind a `MergeDeps` seam so unit tests make no real subprocess calls.
- The never-auto-merge guarantee in `pipeline-state-machine` must remain structural, not relaxed.

## Goals / Non-Goals

**Goals:**
- Add `pipeline merge <pr>` as a human-only sub-command that squash-merges a PR and deletes its branch.
- Enforce three gates before merging: PR mergeability/cleanliness, required-checks status, issue stage (`pipeline:ready-to-deploy`).
- Keep the autonomous `advance` loop entirely merge-free; assert this with a unit test.
- Follow the established DI deps pattern (`MergeDeps`) so unit tests are fast and hermetic.

**Non-Goals:**
- Auto-merge / loop-invoked merge (forbidden by rule #4).
- Tagging or publishing a GitHub Release (that's `pipeline release`).
- Pipeline-desk UI changes (the desk calls this command; no desk-side changes here).
- Changing the `pipeline-state-machine` advance loop in any way.

## Decisions

### Decision: New `core/scripts/stages/merge.ts` module (not inline in pipeline.ts)
Consistent with `release`, `intake`, and `sweep`: each human sub-command lives in its own module. `pipeline.ts` only dispatches. This keeps `pipeline.ts` a thin router and puts the testable logic in a focused module.

*Alternative considered*: inline the ~50-line handler in `pipeline.ts`. Rejected — mixes routing and policy, makes the test surface harder to isolate.

### Decision: Squash merge strategy; always delete branch
The repo norm is squash-merge + branch deletion (matching how GitHub merges pipeline PRs today). Hardcoding this avoids a config knob with no current demand.

*Alternative considered*: make merge strategy configurable. Rejected — YAGNI; adds config complexity for a single existing use case.

### Decision: Gate order: mergeability → required checks → issue stage
1. Mergeability / conflicts (`mergeable == MERGEABLE && mergeStateStatus == CLEAN`) — cheapest check, catches the most common blockers first.
2. Required checks passing (all required status checks green) — verifies CI before touching state.
3. Linked issue at `pipeline:ready-to-deploy` — the human gate; verifies the pipeline itself blessed the change.

A failure at any gate produces a specific, actionable error. Ordering cheapest-first means most failures surface quickly without extra API calls.

*Alternative considered*: check issue stage first. Rejected — a stage check that passes but then fails on conflicts wastes a `gh issue` call for nothing; mergeability is always checked via `gh pr view` which is already required.

### Decision: `MergeDeps` seam (not spawning `gh` directly in the handler)
All `gh pr merge`, `gh pr view`, and `gh issue` calls are injected via a `MergeDeps` interface. Real deps call `gh`; test deps return fixtures. Pattern is identical to `AdvanceReviewDeps`, `ShaGateDeps`, `VerifyDeps` already in the codebase.

### Decision: Loop-isolation test as a black-box assertion over all stage dispatch paths
A unit test imports the stage dispatch table and asserts that no path calls any function from `merge.ts` (by symbol reference). This is stronger than a documentation comment and survives future stage additions.

### Decision: `gh pr view --json mergeable,mergeStateStatus,statusCheckRollup,headRefName` — verify field names before coding
The field names `mergeable`, `mergeStateStatus`, `statusCheckRollup`, and `headRefName` must be confirmed with a live `gh pr view N --json` call during implementation. This is a hard rule (CLAUDE.md #5); do not guess.

## Risks / Trade-offs

- **gh API field drift** → Mitigation: verify every `--json` field name with `gh pr view <N> --json <field>` in a live call at the start of implementation; add a type-guard test.
- **Issue↔PR linkage** → The issue-gate step must use `getPrForIssue` (the authoritative resolver from `pr-resolution` spec) rather than re-implementing resolution. Mitigation: import and call `getPrForIssue` directly; covered by `pr-resolution`'s own tests.
- **Required-checks detection** → `statusCheckRollup` nests check states; the exact shape needs verification. Mitigation: read the live `gh` output; add a fixture-based unit test for the rollup parser.
- **Branch deletion fails silently** → `gh pr merge --delete-branch` deletes the branch server-side; if the branch is already deleted the command may exit non-zero. Mitigation: treat `branch already deleted` as a non-fatal warning, not an error.
