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

### Requirement: Review non-convergence SHALL have a distinct blocker kind and recovery recipe
The closed `BlockerKind` set SHALL include `review-findings`. Exact review recurrence,
non-demotable surface recurrence, and non-demotable round-ceiling exhaustion SHALL use this kind
when actionable blocking findings remain. Its recipe SHALL state that the durable controller owns
bounded remediation and fresh review and that manual intervention is reserved for typed exhaustion
or an explicit authority decision. Diagnostic projection SHALL map `review-findings` to the
distinct durable `review-findings` class and recover disposition.

#### Scenario: Review recurrence uses review-findings
- **WHEN** all current blocking findings recur after an attested fix attempt
- **THEN** `setBlocked` SHALL receive blocker kind `review-findings`
- **AND** the diagnostic SHALL project to durable class `review-findings` and disposition `recover`

#### Scenario: Recipe remains actionable and non-human
- **WHEN** the blocked recipe for `review-findings` is rendered
- **THEN** it SHALL describe bounded controller remediation followed by a fresh review
- **AND** it SHALL NOT instruct the operator to answer, override, or clear a false human hold as the primary action

#### Scenario: Exhaustiveness tests cover review-findings
- **WHEN** blocker recipe and intervention mappings are inspected by the test suite
- **THEN** `review-findings` SHALL have a non-empty recipe and a deterministic mapping

### Requirement: Review recovery SHALL bypass stage-local retry and label-only redispatch
`review-findings` SHALL NOT be eligible for the stage-local `auto_loop`. Its durable policy entry
SHALL select `repair_pipeline_item` as the first action and SHALL NOT select `rerun_ci`,
`resync_workflow_state`, or another label-clearing action before substantive repair.

#### Scenario: Auto-loop leaves review recovery to the supervisor
- **WHEN** a review stage returns a blocked `review-findings` outcome
- **THEN** the in-process auto-loop SHALL NOT clear the block or repeat the same review stage
- **AND** the durable supervisor SHALL retain the diagnostic for recovery

#### Scenario: First durable action repairs the candidate
- **WHEN** the supervisor claims a `review-findings` recovery attempt with a current candidate head
- **THEN** its selected action SHALL be `repair_pipeline_item`
- **AND** no earlier action SHALL redispatch the unchanged candidate

### Requirement: Every setBlocked production site SHALL couple to the escalation disposition inventory

Every production `setBlocked` call site SHALL appear in the escalation-site disposition inventory
with a stable site id, module path, blocker kind (when known), and safety disposition. The
existing `BlockerKind` / `BLOCKER_RECIPES` exhaustiveness requirements remain in force: kind-specific
operator recipes continue to render for human unblock guidance. Disposition governs automatic
retry eligibility before the block is raised; recipes govern post-block operator guidance. A site
MUST NOT call `setBlocked` for a pure `transient-retryable` failure until the site-local bounded
wrapper has exhausted its budget (or a non-transient classification is proven).

#### Scenario: Inventory row exists for each production setBlocked site

- **WHEN** the disposition drift-guard scans production `setBlocked` call sites
- **THEN** each site SHALL match an inventory entry carrying disposition and site id
- **AND** the test SHALL fail if a site is missing

#### Scenario: Transient-retryable path does not first-hop setBlocked on a single 5xx

- **WHEN** a `transient-retryable` site encounters a single retryable gh 5xx before budget
  exhaustion
- **THEN** the site SHALL retry via its wrapper
- **AND** SHALL NOT call `setBlocked` solely for that first transient failure

#### Scenario: BlockerKind recipes remain exhaustive

- **WHEN** a new `BlockerKind` is required by a dispositioned site
- **THEN** `BLOCKER_RECIPES` and recipe snapshot coverage SHALL include that kind
- **AND** the kind SHALL project into the canonical stage-diagnostic reason vocabulary
)

### Requirement: BlockerKind SHALL include review independent-quorum and no-usable-reviewers classes

The `BlockerKind` enum SHALL include distinct members for independent-quorum failure and no-usable-reviewers failure on the review seam (stable string ids such as `review-independent-quorum-unmet` and `review-no-usable-reviewers`). Each new kind SHALL have a non-empty `BLOCKER_RECIPES` entry. The quorum-unmet recipe SHALL direct the operator to restore independent coverage (add a distinct provider/model-family reviewer, fix self-review-only degradation, or adjust config with audit) and re-run after clearing the block; it SHALL NOT instruct silent approve. The no-usable-reviewers recipe SHALL direct the operator to restore reviewer harness availability (CLI install/auth/capacity), then clear the block and re-run; it SHALL NOT classify the failure as product-judgment needs-human by default.

#### Scenario: quorum unmet kind has a recipe

- **WHEN** `setBlocked` is called with the independent-quorum-unmet kind
- **THEN** the blocked comment "### How to unblock" section SHALL contain the quorum recipe text
- **AND** SHALL mention independent coverage or quorum
- **AND** SHALL NOT instruct the operator merely to approve without restoring coverage

#### Scenario: no usable reviewers kind has a recipe

- **WHEN** `setBlocked` is called with the no-usable-reviewers kind
- **THEN** the blocked comment "### How to unblock" section SHALL contain harness/availability recovery steps
- **AND** SHALL NOT default to the product-judgment override recipe alone

#### Scenario: new kinds appear in recipe coverage tests

- **WHEN** the BlockerKind recipe snapshot or exhaustiveness tests run
- **THEN** they SHALL include the new quorum and no-usable kinds
- **AND** SHALL fail if either recipe string is empty or missing

### Requirement: Pre-merge first-conflict recovery SHALL NOT terminate on the merge-conflict manual-rebase recipe

The pre-merge true-conflict recovery path SHALL NOT call `setBlocked` with
`kind: "merge-conflict"` as the terminal outcome of a first clean auto-rebase conflict
or solely because the clean rebase bound was hit (early-conflict and post-CI
CONFLICTING/DIRTY). The `BlockerKind` value `merge-conflict` and its `BLOCKER_RECIPES`
entry MAY remain for surfaces that still park with that kind (for example merge-queue
hold reporting). Therefore the merge-conflict “Rebase… resolve… push…” recipe SHALL NOT
be the operator-visible terminal for that pre-merge first-conflict case.

#### Scenario: First clean auto-rebase miss does not post merge-conflict recipe

- **WHEN** pre-merge clean auto-rebase hits conflicts with resolution budget remaining
- **THEN** the engine SHALL NOT post a `## Pipeline: Blocked` comment whose kind is
  `merge-conflict` for that step
- **AND** SHALL NOT render the merge-conflict recipe (“Rebase the branch… resolve the
  conflicts…”) as that step’s terminal how-to-unblock section

#### Scenario: Residual merge-conflict kind recipe remains defined if the kind exists

- **WHEN** `BlockerKind` still includes `merge-conflict` for other call sites
- **THEN** `BLOCKER_RECIPES` SHALL continue to provide a non-empty recipe for that kind
- **AND** snapshot/recipe tests for the kind MAY remain
- **AND** those residual definitions SHALL NOT authorize pre-merge first-conflict to
  use that kind as its terminal park

### Requirement: BlockerKind includes review-prompt-too-large with a non-same-payload recipe

The `BlockerKind` closed set SHALL include the member `review-prompt-too-large`, used when a review round refuses to spawn because the fully assembled review prompt exceeds the effective reviewer input character ceiling.

`BLOCKER_RECIPES` SHALL map `review-prompt-too-large` to a non-empty recipe that:

- states that the assembled review prompt exceeded the reviewer input ceiling;
- directs the operator that re-running the pipeline **without** reducing the assembled prompt or changing the reviewer/ceiling configuration will fail the same way;
- directs a path that requires a material change (payload, reviewer assignment, or follow-up that shrinks assembly) before a successful re-run;
- SHALL NOT advise that a transient timeout can be “unblocked and re-run as-is”;
- SHALL NOT present generic label-clear-only `--unblock` as sufficient recovery for this class.

Exhaustiveness and recipe snapshot/string-assertion coverage that already pins every `BlockerKind` SHALL include this member so an absent or emptied recipe fails the test suite.

#### Scenario: review-prompt-too-large is a closed BlockerKind member

- **WHEN** the `BLOCKER_KINDS` enum is inspected
- **THEN** it SHALL contain `review-prompt-too-large`
- **AND** `BLOCKER_RECIPES` SHALL contain a non-empty string for that kind

#### Scenario: Recipe refuses same-payload re-run guidance

- **WHEN** `setBlocked` is called with kind `review-prompt-too-large`
- **THEN** the posted “### How to unblock” section SHALL state that re-running without reducing the prompt or changing the reviewer/ceiling will fail again
- **AND** the recipe text SHALL NOT contain the phrase “re-run as-is”
- **AND** the recipe text SHALL NOT claim a transient timeout can be cleared by unblock alone

#### Scenario: Snapshot exhaustiveness covers the new kind

- **WHEN** the blocked-recipe snapshot or exhaustiveness tests run
- **THEN** they SHALL assert a non-empty `BLOCKER_RECIPES` entry for `review-prompt-too-large`
- **AND** a missing or empty entry SHALL fail the test suite
