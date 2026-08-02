## ADDED Requirements

### Requirement: Clean no-commit disclosure SHALL defer terminal disposition to shared goal evaluation on migrated pre-merge paths

For the pre-merge bounded auto-fix clean no-commit case, the existing loud disclosure (harness ran, worktree clean, nothing salvageable) SHALL remain, and terminal disposition SHALL continue to defer to re-verify / goal satisfaction rather than immediate `needs-human` solely for clean no-commit. That terminal disposition SHALL be aligned with the shared `noop-advance-contract` evaluation used by `pre-merge-fix-round`. Dirty no-commit salvage rules, pipeline-internal marker exclusion, and failure-reason disclosure SHALL remain unchanged.

#### Scenario: Clean pre-merge no-commit still discloses then evaluates goal

- **WHEN** the pre-merge bounded auto-fix harness exits with no new commit and a clean worktree
- **THEN** the pipeline SHALL still emit the clean/no-recoverable-work disclosure as already required
- **AND** SHALL enter re-verify / shared goal evaluation rather than immediately setting `blocked`/`needs-human` solely for clean no-commit

#### Scenario: Dirty salvage path unchanged

- **WHEN** a harness exits with no new commit and a dirty salvageable worktree
- **THEN** salvage SHALL still stage and commit under existing rules
- **AND** SHALL NOT be replaced by a goal-satisfaction advance that skips salvage
