# harness-commit-gitignore-warning Specification

## Purpose
TBD - created by archiving change harness-commit-gitignore-warning. Update Purpose after archive.
## Requirements
### Requirement: The pipeline SHALL warn when a harness commit step leaves a change-referenced gitignored artifact uncommitted

The pipeline SHALL, after a harness commit step in the implementing and fix-round stages produces a non-empty commit range, detect untracked files the worktree's
gitignore excludes that are referenced by name in the committed diff, and SHALL report
each such file — naming the file and the matching ignore rule and source — in both the
stage output and the run evidence (`events.jsonl`). The detection SHALL run only when
the harness range is non-empty (`headBefore` and `headAfter` differ); an empty range
SHALL produce no detection and no warning.

#### Scenario: Implementing commit references a gitignored artifact

- **WHEN** the implementing harness commits a change whose diff names a file
  `benchmark/regime_4cell/results.json`
- **AND** that file is present untracked in the worktree and excluded by a `.gitignore`
  `*.json` rule
- **THEN** the pipeline SHALL emit a stage-output warning naming
  `benchmark/regime_4cell/results.json` and the matching ignore rule and source
- **AND** SHALL append an `ignored_artifact_warning` event to `events.jsonl` carrying
  that file and its rule/source

#### Scenario: Fix-round commit references a gitignored artifact

- **WHEN** a fix-round harness produces a commit (`headBefore !== headAfter`) whose diff
  names an untracked file excluded by gitignore
- **THEN** the pipeline SHALL emit the same stage-output warning and
  `ignored_artifact_warning` event naming the file and its rule/source

#### Scenario: Empty harness range produces no detection

- **WHEN** a harness commit step exits with `headBefore === headAfter` (no commit)
- **THEN** the pipeline SHALL NOT run the ignored-artifact detection and SHALL emit no
  warning

### Requirement: The detection SHALL target change-referenced ignored files and suppress routine ignored clutter

The detection SHALL flag an ignored untracked file only when its repository-relative
path or its basename appears literally in the text of the committed diff. An ignored
untracked file not referenced by the committed diff SHALL NOT produce a warning, so that
routine ignored clutter — caches, `__pycache__`, build directories, `node_modules` — does
not warn on every run.

#### Scenario: Unreferenced ignored clutter does not warn

- **WHEN** a harness commit step produces a commit whose diff does not name
  `__pycache__/foo.pyc` and does not name any file under `node_modules/`
- **AND** those ignored files are present untracked in the worktree
- **THEN** the pipeline SHALL NOT emit a warning or `ignored_artifact_warning` event for
  them

#### Scenario: A referenced ignored file among clutter is the only one flagged

- **WHEN** the worktree contains several ignored untracked files but the committed diff
  names only one of them
- **THEN** the warning SHALL name only the diff-referenced ignored file and SHALL NOT
  name the unreferenced ignored files

### Requirement: The detection SHALL be advisory and fail-safe

The detection SHALL be advisory only: it SHALL NOT set a blocker, SHALL NOT change the
stage's advance or blocking outcome, and SHALL NOT mutate the worktree, stage, force-add,
or un-ignore the excluded file. Any git error encountered during detection SHALL be
non-fatal: the stage SHALL proceed without a warning exactly as if no ignored artifact
were present. A repository with no change-referenced ignored files SHALL behave exactly
as before this capability, with no additional output and no additional event.

#### Scenario: Detection never blocks or mutates

- **WHEN** the detection flags a change-referenced ignored file
- **THEN** the stage SHALL emit the advisory warning and SHALL proceed to the same
  advance or blocked outcome it would have reached without the detection
- **AND** the pipeline SHALL NOT stage, commit, force-add, or un-ignore the flagged file

#### Scenario: A git failure during detection is non-fatal

- **WHEN** a git command invoked by the detection (listing ignored files, reading the
  committed diff, or resolving the ignore rule) fails
- **THEN** the detection SHALL emit no warning and SHALL NOT throw
- **AND** the stage SHALL proceed exactly as it would have without the detection

#### Scenario: Repo with no change-referenced ignored files is unchanged

- **WHEN** a harness commit step produces a commit and no ignored untracked file is
  referenced by the committed diff
- **THEN** the pipeline SHALL emit no warning and no `ignored_artifact_warning` event
- **AND** the stage output and run evidence SHALL be identical to the pre-capability
  behavior

### Requirement: The detection SHALL be injectable and have biting regression tests

The detection logic SHALL accept an injectable deps seam (git listing of ignored files,
committed-diff text, ignore-rule resolution, and event emission) so unit tests exercise
every branch with fakes and perform no real git, network, or subprocess call, mirroring
the existing `SalvageDeps` / `VerifyDeps` pattern. The test suite SHALL include a
regression test that drives "a harness commits a change referencing a gitignored file"
and asserts the warning names the file and its ignore rule and that the
`ignored_artifact_warning` event is emitted; the test SHALL bite — with the detection
removed, the same input SHALL produce no warning and no event.

#### Scenario: Unit test exercises the referenced-file path with fakes

- **WHEN** the fake ignored-file lister returns a path that the fake committed-diff text
  references and the fake ignore-rule resolver returns a rule/source
- **THEN** the test SHALL assert the warning names that file and rule and that the
  `ignored_artifact_warning` event payload contains the file and rule
- **AND** SHALL assert no real git or subprocess is invoked

#### Scenario: Regression test bites without the detection

- **WHEN** the detection is removed and the same harness commits a change referencing a
  gitignored file
- **THEN** the test SHALL observe no warning and no `ignored_artifact_warning` event
- **AND** the test SHALL fail, proving it guards the fix

#### Scenario: Unit test exercises the git-failure fail-safe

- **WHEN** a fake git seam throws
- **THEN** the test SHALL assert the detection returns no warning and does not throw

