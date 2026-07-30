## MODIFIED Requirements

### Requirement: Pre-merge bounded auto-fix SHALL salvage uncommitted work instead of discarding it

The pre-merge bounded auto-fix path SHALL, when its fix harness exits (whether it reported success,
crashed, or timed out) having produced **no new commit** (`headAfter === headBefore`) while the
worktree contains genuine uncommitted changes, salvage that uncommitted work into a commit rather
than running `git reset --hard` / `git clean -fd` and returning `error`. The salvaged commit SHALL
then be handled exactly like a harness-authored auto-fix commit: it SHALL be amended to carry the
canonical `PRE_MERGE_AUTOFIX_PREFIX` subject (so the one-attempt bound still detects it), it SHALL
include the `Issue:`/`Pipeline-Run:` traceability trailers, it SHALL be pushed to the PR head, and it
SHALL be subjected to the pre-merge delta review-SHA gate (re-review). Salvage here SHALL reuse the
shared salvage helper (staging the whole worktree minus `node_modules` and pipeline-internal marker
files) and SHALL NOT bypass re-review. When the worktree is genuinely clean (nothing to salvage), the
pipeline SHALL NOT create a salvage commit; it SHALL expose a distinct **noop-clean** outcome (after
any no-op rollback) so the pre-merge stage can re-verify findings against HEAD rather than treating
the clean tree as an immediate unrecoverable hard block.

#### Scenario: Pre-merge auto-fix harness leaves uncommitted work — salvaged, pushed, re-reviewed

- **WHEN** the pre-merge bounded auto-fix harness exits with `headAfter === headBefore`
- **AND** `git status --porcelain` in the worktree reports genuine uncommitted changes (not only
  `node_modules` or a pipeline-internal marker)
- **THEN** the pipeline SHALL create a salvage commit from the uncommitted work instead of running
  `git reset --hard` / `git clean -fd`
- **AND** the resulting commit SHALL carry the `PRE_MERGE_AUTOFIX_PREFIX` subject and the
  `Issue:`/`Pipeline-Run:` trailers
- **AND** the pipeline SHALL push it to the PR head and the pre-merge review-SHA gate SHALL re-review
  the new head rather than treating it as already-approved

#### Scenario: Pre-merge auto-fix harness times out with a dirty worktree — work salvaged, not discarded

- **WHEN** the pre-merge bounded auto-fix harness invocation returns `!result.success` (timeout or
  crash)
- **AND** the worktree contains genuine uncommitted changes
- **THEN** the pipeline SHALL attempt salvage before any `git reset --hard` rollback
- **AND** SHALL NOT discard the uncommitted work when salvage succeeds

#### Scenario: Pre-merge auto-fix worktree is clean — noop-clean for re-verify, no salvage commit

- **WHEN** the pre-merge bounded auto-fix harness exits with no new commit
- **AND** `git status --porcelain` reports the worktree is clean (nothing salvageable)
- **THEN** the pipeline SHALL NOT create a salvage commit
- **AND** SHALL expose a distinct noop-clean outcome (not a silent success)
- **AND** SHALL NOT treat the clean no-commit alone as sufficient to set `blocked`/`needs-human`
  without the pre-merge clean-noop re-verify path

#### Scenario: Salvaged pre-merge fix respects the one-attempt bound

- **WHEN** a pre-merge auto-fix salvage produces a commit carrying `PRE_MERGE_AUTOFIX_PREFIX`
- **THEN** the one-attempt bound SHALL detect that commit by subject prefix
- **AND** the pipeline SHALL NOT launch a second bounded auto-fix attempt for the same finding round

### Requirement: A ran-but-no-recoverable-work pre-merge outcome SHALL be a disclosed escalation

The pipeline SHALL NOT report a silent clean / no-op outcome (for example a bare
`0 transitions … nothing to salvage`) when the pre-merge fix path invokes the harness and the
harness exits (success, crash, or timeout) leaving the inspected worktree clean with no new
commit (`headAfter === headBefore` and `git status --porcelain` empty). In that case the
pipeline SHALL emit a diagnostic that names the inspected worktree path and states that the
harness ran but no recoverable work was found there. That disclosure SHALL feed the pre-merge
**clean-noop re-verify** path (`pre-merge-fix-round`): the pipeline SHALL re-verify blocking
findings against the current head and SHALL escalate to `needs-human` only when re-verify still
finds blocking defects (or re-verify is unavailable and fail-closed rules require escalation) —
not solely because the worktree was clean. The existing fail-closed rollback mechanics and the
`#547` salvage behavior for a dirty worktree SHALL be unchanged; this requirement preserves
disclosure for the clean/no-commit case and defers terminal disposition to re-verify.

#### Scenario: Harness ran but worktree is clean with no commit — loud disclosure then re-verify

- **WHEN** the pre-merge fix harness for issue N exits and the inspected worktree is clean with
  no new commit (nothing for salvage to recover)
- **THEN** the pipeline SHALL emit a diagnostic that includes the inspected worktree path and
  states the harness produced no recoverable work in that worktree
- **AND** the pipeline SHALL enter the clean-noop re-verify path rather than immediately
  treating the clean tree as terminal `needs-human`
- **AND** the pipeline SHALL NOT report a silent success / no-op outcome for the step

#### Scenario: Dirty-worktree salvage and rollback mechanics are unchanged

- **WHEN** the pre-merge bounded auto-fix harness exits with `headAfter === headBefore` and a
  **dirty** worktree containing genuine uncommitted changes
- **THEN** the pipeline SHALL salvage that work exactly as specified by the `#547` pre-merge
  salvage requirement (amend to the auto-fix subject, push, re-review)
- **AND** the disclosure requirement above SHALL NOT alter that dirty-worktree salvage path

#### Scenario: Disclosure regression test bites

- **WHEN** the disclosure is removed so the clean/no-commit pre-merge path proceeds or escalates
  without naming the inspected worktree (reverting to the silent no-op)
- **THEN** the regression test asserting the diagnostic contains the inspected worktree path
  SHALL fail

#### Scenario: Immediate hard-block on clean no-commit without re-verify is a regression

- **WHEN** the clean no-commit path sets `needs-human` without invoking re-verify
- **THEN** the clean-noop re-verify regression tests in `pre-merge-fix-round` SHALL fail
