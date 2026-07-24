## ADDED Requirements

### Requirement: The pre-merge fix harness SHALL run in the worktree the pipeline inspects for salvage

The pre-merge fix harness SHALL execute with its process working directory equal to the exact
managed worktree path the pipeline subsequently inspects for uncommitted-work salvage,
new-commit detection, and the test gate. This SHALL hold for the fix harness invoked during a
pre-merge advance or override-resume on both surfaces: the pre-merge bounded auto-fix path
(`performPreMergeAutoFix`) and the full-fix stage reached when an override relabels a
`needs-human` item back to `review-*` and the advance loop routes into the fix stage. The
harness cwd and the salvage/commit/HEAD inspection SHALL be derived from a single worktree
handle for the issue, so they cannot diverge. When an external stage executor is configured
(`invokeStageExecutor`), the executor SHALL run the harness in that same worktree, or the
pipeline SHALL inspect the executor's actual worktree — the pipeline SHALL NOT run the harness
in one checkout and inspect a different checkout for salvage.

#### Scenario: Pre-merge bounded auto-fix harness cwd equals the salvage-inspected worktree

- **WHEN** the pre-merge bounded auto-fix invokes the fix harness for issue N
- **THEN** the cwd passed to the harness SHALL equal the worktree path passed to the salvage /
  `git status` / new-commit inspection for issue N
- **AND** both SHALL be the single managed worktree resolved for issue N (no second, distinct
  checkout is introduced between the harness invocation and the salvage inspection)

#### Scenario: Override-relabel full-fix harness runs in the inspected worktree even via an external executor

- **WHEN** an override relabels a `needs-human` item to `review-*`, the advance loop routes it
  into the fix stage, and the fix-stage harness call is served by an external stage executor
  (`invokeStageExecutor`) rather than the in-process `invoke`
- **THEN** the executor SHALL run the harness in the issue's managed worktree
- **AND** the worktree the pipeline inspects for salvage / new-commit detection SHALL be that
  same worktree — the harness edits and the salvage inspection SHALL NOT target different
  checkouts

#### Scenario: Worktree-locality invariant is drift-guarded by a regression test

- **WHEN** the fix-harness worktree-locality test exercises the pre-merge fix path with the
  `invokeFn` / executor and salvage deps seams (no real subprocess, git, or network)
- **THEN** the test SHALL assert the cwd handed to the harness equals the path handed to the
  salvage/status inspection
- **AND** the test SHALL fail (bite) if the harness is routed to a different checkout than the
  one the salvage inspection reads

### Requirement: A ran-but-no-recoverable-work pre-merge outcome SHALL be a disclosed escalation

The pipeline SHALL NOT report a silent clean / no-op outcome (for example a bare
`0 transitions … nothing to salvage`) when the pre-merge fix path invokes the harness and the
harness exits (success, crash, or timeout) leaving the inspected worktree clean with no new
commit (`headAfter === headBefore` and `git status --porcelain` empty). In that case the
pipeline SHALL emit a diagnostic that names the inspected worktree path and states that the
harness ran but no recoverable work was found there, and SHALL escalate the item to
`needs-human`. The existing fail-closed rollback mechanics and the `#547` salvage behavior for a
dirty worktree SHALL be unchanged; this requirement adds disclosure to the clean/no-commit
escalation only and SHALL NOT extend salvage coverage.

#### Scenario: Harness ran but worktree is clean with no commit — loud escalation naming the worktree

- **WHEN** the pre-merge fix harness for issue N exits and the inspected worktree is clean with
  no new commit (nothing for salvage to recover)
- **THEN** the pipeline SHALL emit a diagnostic that includes the inspected worktree path and
  states the harness produced no recoverable work in that worktree
- **AND** the pipeline SHALL escalate the item to `needs-human`
- **AND** the pipeline SHALL NOT report a silent success / no-op outcome for the step

#### Scenario: Dirty-worktree salvage and rollback mechanics are unchanged

- **WHEN** the pre-merge bounded auto-fix harness exits with `headAfter === headBefore` and a
  **dirty** worktree containing genuine uncommitted changes
- **THEN** the pipeline SHALL salvage that work exactly as specified by the `#547` pre-merge
  salvage requirement (amend to the auto-fix subject, push, re-review)
- **AND** the disclosure requirement above SHALL NOT alter that dirty-worktree salvage path

#### Scenario: Disclosure regression test bites

- **WHEN** the disclosure is removed so the clean/no-commit pre-merge path escalates without
  naming the inspected worktree (reverting to the silent no-op)
- **THEN** the regression test asserting the escalation diagnostic contains the inspected
  worktree path SHALL fail
