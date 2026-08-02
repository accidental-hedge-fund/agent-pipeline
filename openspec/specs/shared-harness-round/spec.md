# shared-harness-round Specification

## Purpose
TBD - created by archiving change extract-shared-harness-round-pipeline-commits. Update Purpose after archive.
## Requirements
### Requirement: Shared harness-round helper SHALL own the common implementer-round skeleton

The pipeline SHALL provide a single shared harness-round helper under `core/scripts/` that implements the common implementer-round lifecycle for stages that invoke a commit-producing harness: optional worktree reattach, capture of `headBefore` before harness invocation, harness invoke, salvage of uncommitted work when the stage's no-new-commit path requires it, commit-range / subject verification via caller-supplied checks, optional format and test gates, and optional push coordination. Stage modules SHALL NOT maintain a private full copy of that skeleton once migrated. Stage-specific product policy (prompts, commit subject patterns, one-attempt bounds, noop-clean outcomes, re-review routing) SHALL remain in the stage and SHALL be supplied to the helper as parameters or callbacks.

#### Scenario: Helper captures HEAD before invoke

- **WHEN** a migrated consumer runs a harness-round through the shared helper
- **THEN** the helper SHALL record `headBefore` from the worktree before the harness process is spawned
- **AND** subsequent salvage and commit-range checks SHALL use that captured value

#### Scenario: Stage-specific verification remains stage-owned

- **WHEN** fix-round and visual-fix both use the shared helper
- **THEN** each SHALL supply its own commit-format / verification callback
- **AND** the helper SHALL NOT substitute a single global commit-subject rule for both stages

#### Scenario: Injectable deps for unit tests

- **WHEN** unit tests exercise the shared helper
- **THEN** git, invoke, salvage, verify, format/test, and push operations SHALL be injectable via a deps/options seam
- **AND** those tests SHALL NOT require real network, git, or harness subprocesses

---

### Requirement: Fix, planning implement, visual-fix, eval-fix, and pre-merge auto-fix SHALL consume the shared helper

The fix-round path, planning implement path, visual-fix path, eval-fix path, and pre-merge bounded auto-fix path SHALL each invoke the shared harness-round helper for the common skeleton rather than duplicating reattach / head capture / salvage / commit-gate / format-test / push orchestration privately. Migration SHALL preserve each path's pre-change observable outcomes for salvage success, salvage failure disclosure, clean no-commit blocks, format/test failures, and successful push/advance.

#### Scenario: Fix-round uses the shared helper

- **WHEN** the fix stage runs a review-fix harness round
- **THEN** reattach, head capture, invoke, salvage, and commit-gate sequencing SHALL go through the shared helper
- **AND** existing fix commit-format and crash-retry product rules SHALL still apply

#### Scenario: Planning implement uses the shared helper

- **WHEN** the planning stage runs the implement harness (success and crash/timeout paths that already salvage)
- **THEN** the shared helper SHALL own the common skeleton for that implement round
- **AND** implement issue-ref verification and format/test gates SHALL still run as before

#### Scenario: Visual-fix and eval-fix use the shared helper

- **WHEN** the visual-gate or eval-gate fix harness runs
- **THEN** head capture, salvage, commit-format verification, and push coordination SHALL use the shared helper
- **AND** each stage's prescribed fix commit subject pattern SHALL remain enforced

#### Scenario: Pre-merge auto-fix uses the shared helper

- **WHEN** `performPreMergeAutoFix` (or its successor) runs the bounded auto-fix implementer
- **THEN** the common skeleton SHALL run through the shared helper
- **AND** amend-to-auto-fix-prefix, one-attempt bound, noop-clean, push, and delta re-review product rules SHALL remain pre-merge-owned and unchanged in outcome

---

### Requirement: Shared harness-round extraction SHALL NOT change salvage semantics

Wiring stages to the shared helper SHALL NOT alter the living `harness-uncommitted-salvage` contract: when salvage runs, staging exclusions (`node_modules` depth-agnostic, pipeline-internal markers), scoped OpenSpec authoring salvage, salvage subject and trailers, failure-reason disclosure, and “salvage never bypasses validation” SHALL behave as before. The helper SHALL call the existing salvage implementation rather than reimplementing salvage.

#### Scenario: Dirty no-commit path still salvages

- **WHEN** a migrated consumer's harness exits with no new commit and a dirty worktree that salvage accepts
- **THEN** the pipeline SHALL create a salvage commit via the existing salvage helper
- **AND** SHALL proceed to the same downstream verification as a harness-authored commit

#### Scenario: Clean no-commit path still does not invent work

- **WHEN** a migrated consumer's harness exits with no new commit and a clean worktree
- **THEN** the pipeline SHALL NOT create a salvage commit
- **AND** SHALL follow the stage's existing block or noop-clean outcome

---

### Requirement: Loop repair_pipeline_item SHALL be a shared-round consumer or a documented tested exemption

The `repair_pipeline_item` recovery executor (PR #787) SHALL either (a) invoke the shared harness-round helper directly for its substantive implementer work, or (b) invoke a migrated pre-merge auto-fix path that itself uses the shared helper, while keeping recovery-shell logic local. Under either disposition, the recovery path SHALL preserve: durable pre-invocation attempt breadcrumb, ownership proof before adopting/amending an unpushed commit, idempotent reconciliation of already-pushed marked repairs, and refusal to adopt unrelated human commits or destroy unprovable local history. A unit/regression test SHALL fail if the substantive implementer path reintroduces a private full skeleton outside the shared stack, and SHALL fail if breadcrumb/ownership refusal protections are removed.

#### Scenario: Substantive repair uses the shared stack

- **WHEN** `repair_pipeline_item` runs a substantive implementer repair for a claimed head
- **THEN** the implementer invocation and salvage/commit skeleton SHALL go through the shared helper or the shared-helper-backed auto-fix path
- **AND** success SHALL still require a committed, remote-verified candidate head before clearing mechanical block state

#### Scenario: Unmarked human commit is refused

- **WHEN** the worktree has moved past the claimed head with a clean unpushed commit that the attempt cannot prove it authored (no matching breadcrumb / marker)
- **THEN** `repair_pipeline_item` SHALL refuse to amend, push, or adopt that commit
- **AND** SHALL return failure evidence rather than publishing the human commit as a recovery repair

#### Scenario: Already-pushed marked repair reconciles without re-invoke

- **WHEN** a prior attempt already pushed a marked recovery commit that is the remote branch head
- **THEN** `repair_pipeline_item` SHALL reconcile that head without replaying the implementer
- **AND** SHALL NOT charge a second implementer repair for that already-verified push

---

### Requirement: Shared harness-round SHALL have biting regression coverage for reattach and salvage

The test suite SHALL retain (or re-home without weakening) regression tests that prove reattach-before-invoke and salvage-on-dirty-no-commit still bite for migrated consumers. At least one test per major consumer family (fix, implement, gate-fix or pre-merge auto-fix) SHALL fail if the shared wiring drops salvage or reattach where the pre-change path required it.

#### Scenario: Dropping salvage from a migrated consumer fails a test

- **WHEN** a unit test simulates a dirty no-commit harness exit for a migrated consumer
- **AND** the shared-round salvage call is removed or short-circuited in the test double wiring under test
- **THEN** the regression assertion SHALL fail (proving the net still bites)

#### Scenario: Reattach failure still blocks before invoke where required

- **WHEN** reattach is required for a consumer and reattach returns not-ok
- **THEN** the round SHALL NOT invoke the harness
- **AND** the stage SHALL surface the reattach failure as before

