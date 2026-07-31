# blocked-recovery-recipes Specification

## Purpose
TBD - created by archiving change blocked-ux-stage-aware-recovery-recipe. Update Purpose after archive.
## Requirements
### Requirement: BlockerKind enum defines a closed set of blocker classes
The pipeline SHALL define a `BlockerKind` string-enum in `core/scripts/types.ts` covering every structurally-distinct failure class that can result in a blocked issue. The enum SHALL include at minimum: `needs-human`, `test-gate-exhausted`, `no-commits`, `harness-failure`, `openspec-invalid`, `openspec-stale-delta`, `merge-conflict`, `worktree-missing`, `worktree-creation-failed`, `pr-creation-failed`, `plan-gen-failed`, `push-failed`.

#### Scenario: BlockerKind enum is exhaustive for all call sites
- **WHEN** every `setBlocked(...)` call in `planning.ts`, `fix.ts`, and `pre_merge.ts` is inspected
- **THEN** each call SHALL pass a `kind` value drawn from `BlockerKind`
- **AND** no call SHALL be added without a corresponding `BlockerKind` member

#### Scenario: BLOCKER_RECIPES map covers every kind
- **WHEN** the `BLOCKER_RECIPES` map is inspected at runtime
- **THEN** it SHALL contain a non-empty string entry for every value in the `BlockerKind` enum
- **AND** no `BlockerKind` value SHALL be absent from the map

### Requirement: setBlocked renders a kind-specific recovery recipe
The `setBlocked` function SHALL accept an optional `kind?: BlockerKind` parameter. When `kind` is provided, the "### How to unblock" section of the blocked comment SHALL render the static recipe string associated with that kind from `BLOCKER_RECIPES`. When `kind` is omitted, the function SHALL default to `needs-human` behavior for backward compatibility.

The `worktree-creation-failed` recipe SHALL include the following specific cleanup steps:
1. Remove the git config lock if present: `rm -f .git/config.lock`
2. Delete the dangling branch: `git branch -D pipeline/<N>-<slug>`
3. Remove the `blocked` label from the GitHub issue
4. Re-run the pipeline

#### Scenario: kind-specific recipe appears in blocked comment
- **WHEN** `setBlocked(cfg, N, reason, stage, "test-gate-exhausted")` is called
- **THEN** the posted GitHub comment SHALL contain the test-gate-exhausted recipe text under "### How to unblock"
- **AND** SHALL NOT contain the generic `--unblock` instruction

#### Scenario: needs-human kind renders the override/fix recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "needs-human")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to fix findings and re-run OR use `--override "<key>: <reason>"` to record a disposition

#### Scenario: test-gate-exhausted kind renders the test-fix recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "test-gate-exhausted")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to fix the failing tests, commit, and re-run the pipeline

#### Scenario: openspec-invalid kind renders the validate-and-fix recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "openspec-invalid")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to run `openspec validate <change>` locally, fix errors, commit, and re-run

#### Scenario: merge-conflict kind renders the rebase recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "merge-conflict")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to rebase on the latest target branch, resolve conflicts, push, and re-run

#### Scenario: missing kind defaults to needs-human recipe
- **WHEN** `setBlocked(cfg, N, reason, stage)` is called without a `kind` argument
- **THEN** the comment SHALL render the `needs-human` recipe (the pre-change behavior)
- **AND** no crash or validation error SHALL occur

#### Scenario: worktree-creation-failed kind renders config-lock cleanup recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "worktree-creation-failed")` is called
- **THEN** the "### How to unblock" section SHALL include `rm -f .git/config.lock`, `git branch -D pipeline/<N>-<slug>`, removing the `blocked` label, and re-running the pipeline

### Requirement: Recovery recipes are pinned by snapshot tests
The pipeline test suite SHALL include a snapshot or string-assertion test that verifies the rendered comment text for every `BlockerKind` value. A recipe string that changes or goes missing SHALL cause the test to fail.

#### Scenario: snapshot test fails when a recipe string is changed
- **WHEN** the `BLOCKER_RECIPES` entry for any kind is edited
- **THEN** the corresponding snapshot assertion SHALL fail at `npm test`
- **AND** the failure message SHALL identify which kind's recipe changed

#### Scenario: snapshot test covers all kinds
- **WHEN** a new value is added to `BlockerKind`
- **THEN** there SHALL be a test asserting that `BLOCKER_RECIPES` contains a non-empty entry for that value
- **AND** the test SHALL fail if the entry is absent

### Requirement: head-drift blocker kind directs the operator to push the local fix

The `BlockerKind` enum SHALL include a `head-drift` member, used when the issue
worktree's local HEAD contains commits not present on the linked PR head (an
unpushed local fix). Its `BLOCKER_RECIPES` entry SHALL be a non-empty recipe that
directs the operator to push the local commits so the PR head includes the fix,
remove the `blocked` label, then re-run the pipeline; the recipe SHALL NOT instruct
the operator merely to clear the `blocked` label without pushing. Because the
existing "BLOCKER_RECIPES map covers every kind" and "Recovery recipes are pinned by
snapshot tests" requirements already range over every `BlockerKind`, the
`head-drift` entry SHALL be covered by those tests without a new test surface.

The `blockerKindToInterventionKind` mapping SHALL map `head-drift` to the
`merge-conflict-or-branch-drift` human-intervention kind, since head drift is a
branch-state divergence between the worktree and the PR.

#### Scenario: head-drift kind renders the push-the-fix recipe

- **WHEN** `setBlocked(cfg, N, reason, "shipcheck-gate", "head-drift")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to push the local commits (so the PR head includes the fix), remove the `blocked` label, and re-run the pipeline
- **AND** SHALL NOT consist solely of the generic clear-the-label instruction

#### Scenario: BLOCKER_RECIPES contains a non-empty head-drift entry

- **WHEN** the `BLOCKER_RECIPES` map is inspected at runtime
- **THEN** it SHALL contain a non-empty string entry for `head-drift`
- **AND** the existing recipe-coverage snapshot test SHALL fail if that entry is absent or emptied

#### Scenario: head-drift maps to a branch-drift intervention kind

- **WHEN** `blockerKindToInterventionKind("head-drift")` is called
- **THEN** it SHALL return `"merge-conflict-or-branch-drift"`

### Requirement: BlockerKind includes ci-exhausted for pre-merge CI budget exhaustion

The `BlockerKind` enum (`BLOCKER_KINDS` in `core/scripts/types.ts`) SHALL include a `ci-exhausted` member used when the pre-merge GitHub CI gate escalates after the per-head-SHA recovery budget is exhausted (re-run / archive-aware recovery / optional assertion fix as applicable). Its `BLOCKER_RECIPES` entry SHALL be a non-empty recipe that directs the operator to inspect the failing check URL(s) and classification in the block reason, fix product test/build failures or address remaining infrastructure issues, push any code fix to the PR head, remove the `blocked` label, then re-run the pipeline. The recipe SHALL state that automatic re-run budget may already have been consumed so a pure re-run without a fix may not be sufficient. The recipe SHALL NOT instruct the operator to use review `--override` as the primary recovery for CI red. Because existing requirements already require `BLOCKER_RECIPES` completeness and snapshot coverage over every `BlockerKind`, adding `ci-exhausted` SHALL update those maps and tests in the same change.

#### Scenario: ci-exhausted is a valid BlockerKind

- **WHEN** `BLOCKER_KINDS` is inspected
- **THEN** it SHALL include the string `ci-exhausted`
- **AND** `BLOCKER_RECIPES["ci-exhausted"]` SHALL be a non-empty string

#### Scenario: setBlocked with ci-exhausted renders the CI recovery recipe

- **WHEN** `setBlocked(cfg, N, reason, "pre-merge", "ci-exhausted")` is called
- **THEN** the posted GitHub comment SHALL contain the `ci-exhausted` recipe text under "### How to unblock"
- **AND** the recipe SHALL direct the operator to fix CI failures and re-run the pipeline after removing `blocked`
- **AND** SHALL NOT present review `--override` as the primary unblock verb for this kind

#### Scenario: pre-merge CI budget exhaustion uses ci-exhausted not bare needs-human

- **WHEN** the pre-merge gate escalates because definitive CI failures remain after the recovery budget for the head SHA is exhausted
- **THEN** the gate SHALL call `setBlocked` with kind `ci-exhausted`
- **AND** SHALL NOT pass only `needs-human` for that escalation path when the dedicated kind is available

#### Scenario: recipe snapshots cover ci-exhausted

- **WHEN** the blocked-recipe snapshot / exhaustiveness tests run
- **THEN** they SHALL assert a non-empty `BLOCKER_RECIPES` entry for `ci-exhausted`
- **AND** SHALL fail if the entry is removed or emptied

### Requirement: Worktree capacity has a distinct blocker kind and ops recipe

The `BlockerKind` closed set SHALL include a distinct member for pure worktree capacity admission failure (for example `worktree-capacity`, exact string locked by implementation tests) that is separate from product `needs-human` and from generic `worktree-creation-failed`. When capacity is the sole create failure, `setBlocked` (or the equivalent outcome path) SHALL use that capacity kind. The associated `BLOCKER_RECIPES` entry SHALL instruct the operator to wait for an active issue to complete or for safe park-release to free a slot, and MAY mention manual safe remove of retained parked worktrees; it SHALL NOT present product-override language or “answer findings / product judgment” as the primary unblock path. Snapshot or string-assertion coverage for recipes SHALL include the capacity kind.

#### Scenario: Capacity kind is not needs-human

- **WHEN** create fails solely because other active worktrees are at `max_concurrent_worktrees`
- **AND** the outcome is recorded with a `BlockerKind`
- **THEN** the kind SHALL be the capacity kind, not `needs-human`

#### Scenario: Capacity recipe is ops-oriented

- **WHEN** the capacity kind's recipe text is rendered
- **THEN** it SHALL describe waiting for capacity or freeing retained parked worktrees
- **AND** it SHALL NOT use the product needs-human override recipe as its primary text

#### Scenario: Recipe map covers the capacity kind

- **WHEN** `BLOCKER_RECIPES` is inspected at runtime
- **THEN** it SHALL contain a non-empty entry for the capacity kind
- **AND** the capacity kind SHALL be a member of the `BlockerKind` enum

### Requirement: worktree-missing recipe SHALL stay accurate when rematerialize is in scope

The `BLOCKER_RECIPES` entry for `worktree-missing` SHALL remain non-empty and actionable. After pre-merge/fix paths rematerialize missing managed worktrees automatically, the recipe SHALL NOT claim that re-running the pipeline will always block immediately without recreation for those paths. When a residual `worktree-missing` or rematerialize-failed park still occurs, the recipe (or the blocking reason paired with `worktree-creation-failed`) SHALL direct the operator at concrete recovery: verify remote branch / open PR recoverability, auth/`gh` access, free worktree capacity, resolve dirty or local-only reclaim blockers under the managed root, remove the `blocked` label when appropriate, then re-run the pipeline. The recipe suite SHALL fail if the text falsely asserts that re-run never recreates the worktree while scoped call sites rematerialize on re-entry.

#### Scenario: Recipe does not deny automatic rematerialize on scoped re-entry

- **WHEN** the rendered `worktree-missing` recipe for issue N is inspected after this change ships
- **THEN** it SHALL NOT state that re-running will always block immediately solely because recreation never runs
- **AND** it SHALL still give an operator a concrete recovery path when rematerialize cannot succeed

#### Scenario: worktree-creation-failed remains the preferred kind after failed create/rematerialize

- **WHEN** rematerialize is attempted and `createWorktree` fails
- **THEN** the call site SHALL use `worktree-creation-failed` (or `worktree-capacity` when capacity-typed) for the block kind
- **AND** the corresponding recipe SHALL continue to cover config-lock / dangling-branch / capacity recovery as already specified

