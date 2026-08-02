# noop-advance-contract Specification

## Purpose
TBD - created by archiving change generalized-noop-advance-contract. Update Purpose after archive.
## Requirements
### Requirement: The engine SHALL provide a stage-agnostic no-new-commit goal-satisfaction contract

The pipeline SHALL expose a single shared evaluation surface (module/API under `core/scripts/`) that, when a harness or equivalent commit-producing round ends with **no new commit** after salvage has run (or correctly determined there is nothing to salvage), evaluates whether the worktree **HEAD already satisfies the declaring stage’s goal**. The evaluation SHALL return a closed decision among at least: **advance** (goal satisfied), **escalate** (goal not satisfied), and **not-applicable** (path is not a clean no-new-commit case — non-empty commit range, successful salvage commit, or insufficient inputs). Stage modules SHALL NOT each maintain a private full copy of this control skeleton once migrated; stage-specific product meaning of “goal” SHALL remain stage-supplied via explicit goal checks.

#### Scenario: Clean no-new-commit with satisfied goal advances

- **WHEN** a migrated stage’s harness round ends with `headAfter === headBefore`, salvage creates no commit, and the stage’s goal check reports satisfied at HEAD
- **THEN** the shared evaluation SHALL return **advance**
- **AND** the stage SHALL NOT invent an empty commit solely to pass a commit-range check
- **AND** the stage SHALL NOT call `setBlocked` with `blockerKind: "no-commits"` solely because no new commit was produced

#### Scenario: Clean no-new-commit with unsatisfied goal escalates

- **WHEN** a migrated stage’s harness round ends with `headAfter === headBefore`, salvage creates no commit, and the stage’s goal check reports unsatisfied
- **THEN** the shared evaluation SHALL return **escalate**
- **AND** the stage SHALL fail closed via its typed blocker path (including `no-commits` or a more specific kind when one already applies)
- **AND** SHALL NOT treat the round as a silent success

#### Scenario: Non-empty commit range is not-applicable

- **WHEN** a harness round produces one or more new commits in the captured range
- **THEN** the shared evaluation SHALL return **not-applicable**
- **AND** the stage SHALL continue its existing commit-gate / advance path without goal-satisfaction short-circuit

#### Scenario: Successful salvage commit is not-applicable to clean-noop advance

- **WHEN** salvage creates a commit after a dirty no-new-commit harness exit
- **THEN** the shared evaluation SHALL return **not-applicable** (or SHALL NOT classify the result as clean-noop goal advance)
- **AND** the stage SHALL follow the existing post-salvage verification path

#### Scenario: Unconfirmed clean/no-salvage status is not-applicable

- **WHEN** `headAfter === headBefore` and salvage did not create a commit, but confirmed clean/no-salvage status is not true (salvage skipped, salvage failed, or worktree cleanliness not proven)
- **THEN** the shared evaluation SHALL return **not-applicable**
- **AND** SHALL NOT invoke the stage goal check solely because HEADs are equal
- **AND** callers SHALL NOT synthesize placeholder HEAD values or treat artifact-directory presence as proof of a clean worktree

### Requirement: Goal satisfaction SHALL be stage-declared and deterministic

Each migrated consumer SHALL supply one or more explicit goal checks that answer whether HEAD already satisfies that stage’s goal. Checks SHALL be deterministic given their injected inputs (comments, HEAD SHA, artifact presence, review partition, active OpenSpec set, gate results as applicable) and SHALL NOT rely solely on unconstrained freeform model judgment as the only satisfaction proof for this contract. At minimum the following goal classes SHALL be expressible:

- **fix-no-actionable-work** — effective blocking set empty after live override subtract, and/or every invoked blocking finding covered by a valid does-not-reproduce (or equivalent sanctioned) declaration at current HEAD, and/or external-commit advance when HEAD is past the reviewed SHA per existing fix rules
- **pre-merge-findings-clear** — after clean auto-fix no-op, re-verify (or equivalent HEAD check) shows no residual blocking findings that still require auto-fix or block under existing partition policy
- **pre-merge-archive-coherent** — active OpenSpec change set empty for a true no-candidates skip, or archive outcome coherent for the same head evaluation (no skip/pass-then-block dual signal on residual active ids)
- **implement-deliverable-present** — declared planning deliverable (including accepted OpenSpec change artifacts already landed in the planning commit for a spec-only issue) is present at HEAD with clean tree relative to the implement headBefore and relevant gates green

#### Scenario: Fix does-not-reproduce maps to fix-no-actionable-work

- **WHEN** a fix round ends with no new commit and valid does-not-reproduce declarations cover every invoked blocking finding at current HEAD
- **THEN** the stage goal check SHALL report satisfied under the fix-no-actionable-work class
- **AND** the shared evaluation SHALL return **advance**

#### Scenario: Pre-merge re-verify clean maps to pre-merge-findings-clear

- **WHEN** pre-merge bounded auto-fix ends noop-clean and re-verify reports no residual blocking findings under existing partition policy
- **THEN** the stage goal check SHALL report satisfied under the pre-merge-findings-clear class
- **AND** the shared evaluation SHALL return **advance** (pre-merge continues without hard-blocking solely for no commit)

#### Scenario: Residual active OpenSpec change is not archive-coherent satisfaction

- **WHEN** the shared active OpenSpec set for the PR head is non-empty and archive did not coherently complete for those ids
- **THEN** the pre-merge-archive-coherent check SHALL report unsatisfied
- **AND** the evaluation SHALL NOT advance solely because a harness made no commit

#### Scenario: Spec-only deliverable already in planning commit satisfies implement-deliverable-present

- **WHEN** implementing (or the implement phase) re-enters with no new implementer commit, a clean worktree, and the accepted OpenSpec deliverable already present from the planning commit
- **AND** relevant gates for that path are green
- **THEN** the implement-deliverable-present check SHALL report satisfied
- **AND** the shared evaluation SHALL return **advance** without requiring an empty implementer commit

### Requirement: Advance SHALL record attested evidence

When the shared evaluation returns **advance**, the pipeline SHALL record an attested evidence note that includes at least: the stage identity, the HEAD SHA evaluated, a machine-readable rationale class (from the goal check), and a short human-readable note. Evidence SHALL use an existing durable channel appropriate to the stage (trusted pipeline comment, structured event / `gate_result`, and/or evidence-bundle field) and SHALL be readable on a subsequent process re-entry. The contract SHALL NOT invent empty commits as the sole form of evidence.

#### Scenario: Evidence names SHA and rationale class

- **WHEN** a no-new-commit round advances because the goal check is satisfied
- **THEN** the recorded evidence SHALL include the evaluated HEAD SHA and the rationale class
- **AND** SHALL be attributable to the pipeline (trusted author / structured event), not an unauthenticated freeform note alone

#### Scenario: Unsatisfied path does not claim goal-satisfied evidence

- **WHEN** the shared evaluation returns **escalate**
- **THEN** the pipeline SHALL NOT record an advance evidence note claiming goal satisfaction for that round

#### Scenario: Advance is refused when durable evidence cannot be recorded

- **WHEN** the shared evaluation returns **advance** but every durable evidence sink (trusted pipeline comment and/or structured event) fails
- **THEN** the pipeline SHALL NOT clear a blocked label or complete a goal-satisfaction advance solely on that evaluation
- **AND** recovery recipes and stage paths SHALL fail closed so the block remains until evidence can be persisted

### Requirement: Recovery re-entry SHALL reuse the same evaluation as the first deterministic no-commits recipe

When durable/autonomous recovery projects a `no-commits` (or equivalent implementation-outcome) block into an `implementation-ci` recovery class, the **first** deterministic recipe SHALL invoke the **same** shared goal-satisfaction evaluation used by normal stage execution for the item’s current stage, with that stage’s goal checks. When the evaluation returns **advance**, recovery SHALL continue/redispatch with attested evidence and SHALL **not** charge model-repair budget for that recipe. When the evaluation returns **escalate** or goal checks are unsatisfied, recovery SHALL NOT treat the item as repaired by this recipe and SHALL proceed to the next configured recipe or fail-closed park. The recipe SHALL NOT introduce a recovery-only per-stage marker that bypasses normal gates (format, test, CI, OpenSpec, review-SHA rules remain in force).

#### Scenario: Satisfied HEAD on recovery advances without model repair

- **WHEN** recovery selects the goal-satisfaction recipe for a `no-commits` / `implementation-ci` item
- **AND** the shared evaluation returns **advance** for the current stage goal at HEAD
- **THEN** recovery SHALL record attested evidence and continue without invoking a model-repair harness for that recipe
- **AND** SHALL NOT consume model-repair budget for a successful goal-satisfaction recipe

#### Scenario: Unsatisfied HEAD does not skip later recovery or gates

- **WHEN** recovery selects the goal-satisfaction recipe
- **AND** the shared evaluation returns **escalate**
- **THEN** recovery SHALL NOT clear the block as repaired solely by this recipe
- **AND** SHALL fall through to the next permitted recipe or fail-closed outcome
- **AND** SHALL NOT bypass normal product gates on a later successful path

### Requirement: Historical false-block scenarios SHALL regress through the shared path

The unit-test suite SHALL cover the shared evaluation and migrated call sites with injected deps (no real network, git, or harness subprocess). Coverage SHALL include at least: (1) #698-shaped pre-merge clean no-commit + re-verify clean → advance/continue; (2) #698-shaped still-broken → escalate once with typed recipe; (3) #714-shaped archive coherence — true empty active set may skip/no-candidates without dual block; residual active still fail closed; (4) #747-shaped mixed partition — allowlisted subset still eligible; clean no-commit does not hard-block solely for no commit when goal check is used; (5) #588-shaped planning deliverable already present — advance without empty implementer commit on a **fresh process/re-entry** style test; (6) fix-stage override-empty / does-not-reproduce / external-commit advances remain green. At least one test per family SHALL fail if the shared evaluation is removed or the stage reverts to hard-block-on-clean-no-commit without a goal check.

#### Scenario: #588 re-entry regression bites without helper-only coverage

- **WHEN** a regression simulates a fresh re-entry into implementing with the OpenSpec deliverable already present from the planning commit and a clean no-new-commit implement harness result
- **THEN** the path SHALL advance without `no-commits` solely for empty range
- **AND** the test SHALL fail if only an in-memory helper is covered while the stage re-entry path still hard-blocks

#### Scenario: #698 paths bite through shared evaluation

- **WHEN** pre-merge auto-fix noop-clean re-verify clean / still-broken tests run
- **THEN** they SHALL exercise the shared evaluation (directly or via a stage adapter)
- **AND** SHALL fail if clean no-commit hard-blocks without goal check or if a second auto-fix attempt is launched solely for re-verify

