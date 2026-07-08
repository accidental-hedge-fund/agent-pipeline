## ADDED Requirements

### Requirement: A repository SHALL be able to declare a build command that fix/auto-fix rounds run

The pipeline config SHALL accept a repo-declared build command (`build_command`, a bare shell string,
top-level in `.github/pipeline.yml`, run via `bash -c`), analogous to the existing test-command declaration.
When present it activates the rebuild-and-fold behavior for fix and auto-fix rounds; when absent the behavior
is inert. The config SHALL parse, validate, and surface the key like other command keys (e.g. it renders as a
commented example in generated `pipeline.yml` and is enumerated by the config-validate/line-lookup surfaces).
There SHALL be no default value, no auto-detection, and no generic fallback that activates the behavior for a
repo that did not declare a command.

#### Scenario: Declared build command is parsed and surfaced

- **WHEN** `.github/pipeline.yml` sets `build_command: npm run build`
- **THEN** the resolved config SHALL expose that command string
- **AND** the config SHALL validate without error
- **AND** the generated `pipeline.yml` renderer SHALL include a `build_command` entry

#### Scenario: No build command declared is inert

- **WHEN** no `build_command` is declared for a repo
- **THEN** the resolved config SHALL carry no build command
- **AND** the pipeline SHALL NOT auto-detect, guess, or otherwise activate a build command from any fallback

### Requirement: A fix round SHALL rebuild and fold declared build artifacts into its commit before the gates

The fix stage SHALL run the declared build command when a fix round produces a commit against a clean
worktree — after the lock-file inclusion (#358) and **before** the format/test gates — and fold any
resulting changes into the round's HEAD commit via
`git commit --amend --no-edit`, so the round's committed generated artifacts match the committed source when
the gates certify it. The amend SHALL preserve the round commit's subject and its `Issue:` and
`Pipeline-Run:` trailers, and SHALL NOT create a separate commit. When the build produces no change, no amend
SHALL occur and the round commit's SHA SHALL be unchanged. Because the format-gate's own auto-fix commits
(run inside the same `runFormatAndTestGates` convergence loop) can also modify source after this initial
fold, the fix stage SHALL re-run the same fold after every format-gate auto-fix commit and before the test
gate re-runs, so the round's **final certified HEAD** — not just its initial commit — has fresh artifacts.

#### Scenario: Fix edits source and build regenerates dist

- **WHEN** a fix round exits with a new commit (`headBefore !== headAfter`) against a clean worktree
- **AND** a `build_command` is declared whose run rewrites a committed artifact (e.g. `dist/bundle.js`)
- **THEN** the fix stage SHALL run the build command before `runFormatAndTestGates`
- **AND** SHALL stage the resulting artifact change and amend the round's HEAD commit to include it
- **AND** the amended commit SHALL retain its original subject and its `Issue:` and `Pipeline-Run:` trailers
- **AND** no separate commit SHALL be created for the artifact
- **AND** after the step `git status --porcelain` SHALL report a clean worktree

#### Scenario: Build produces no change — no amend

- **WHEN** a fix round commits and the declared build command produces no worktree change
- **THEN** the fix stage SHALL NOT amend or create any commit
- **AND** the round commit's SHA SHALL be unchanged

#### Scenario: Rebuild-and-fold runs before the gates certify

- **WHEN** a fix round's build produces an artifact change that is folded into the round commit
- **THEN** the fold SHALL run before `runFormatAndTestGates`
- **AND** the format-gate pre-flight dirty check and the test-gate pre-run dirty check SHALL observe a clean
  worktree and SHALL NOT block on the rebuilt artifact

#### Scenario: A format-gate auto-fix commit is also rebuilt and folded

- **WHEN** the format/test gate convergence loop's format-gate step commits an auto-fix change (e.g. a
  formatter rewrite) after the round's initial build fold already ran
- **THEN** the fix stage SHALL rebuild and fold declared build artifacts into that format-gate commit too,
  before the test gate re-runs
- **AND** re-running the declared build command against the round's final certified HEAD SHALL produce no
  diff

#### Scenario: A build failure during the format-gate loop blocks distinctly

- **WHEN** the rebuild-and-fold triggered by a format-gate auto-fix commit fails (the declared build command
  exits non-zero)
- **THEN** the round SHALL block with the same explicit build-failure reason and `build-failed` blocker kind
  as a failure during the round's initial fold
- **AND** the test gate SHALL NOT run against the stale/broken commit

### Requirement: An auto-fix (test-gate fix-loop) attempt SHALL rebuild and fold declared build artifacts into its commit

The auto-fix path SHALL run the declared build command when a test-gate fix-loop attempt produces a commit,
and SHALL fold any resulting artifact changes into that attempt's commit — after the attempt's existing
clean-tree, commit-format, and trailer checks and **before** the test command re-runs — using the same
amend-no-edit fold as the fix stage, so the auto-fix commit's artifacts match its source.

#### Scenario: Auto-fix attempt rebuilds artifacts before the re-run

- **WHEN** a test-gate fix attempt commits source against an otherwise clean worktree
- **AND** a `build_command` is declared whose run rewrites a committed artifact
- **THEN** the auto-fix path SHALL fold the artifact change into that attempt's commit
- **AND** SHALL do so before the test command re-runs
- **AND** the amended attempt commit SHALL retain its `Issue:` and `Pipeline-Run:` trailers

### Requirement: A declared build-command failure SHALL block explicitly and never commit stale or broken artifacts

When the declared build command exits non-zero during a fix or auto-fix round, the round SHALL block with an
explicit build-failure reason (routed to `needs-human`) that is distinct from the test-gate's
"failed after N fix attempt(s)" message, and SHALL NOT amend or commit any artifact from the failed build.
The captured build output SHALL be included in the block reason, truncated via the gate's existing
output-cap helper when long.

#### Scenario: Build command exits non-zero

- **WHEN** a fix or auto-fix round runs the declared build command and it exits non-zero
- **THEN** the round SHALL block with a build-failure reason routed to `needs-human`
- **AND** the reason SHALL be distinct from the test-gate "failed after N fix attempt(s)" message
- **AND** SHALL include the captured build output (truncated when long)

#### Scenario: An auto-fix attempt's build failure keeps its distinct reason and blocker kind through the top-level result

- **WHEN** a test-gate fix-loop attempt's rebuild-and-fold fails
- **THEN** the resulting `TestGateResult` SHALL carry a flag identifying it as a build failure, not a
  genuine test/build-command failure
- **AND** the fix stage's format/test gate convergence loop SHALL propagate that flag through to its own
  blocked result rather than reporting the test-gate's generic "failed after N fix attempt(s)" wording
- **AND** the round SHALL block with the `build-failed` blocker kind, not `test-gate-exhausted`
- **AND** no amend or artifact commit SHALL occur

### Requirement: The rebuild-and-fold SHALL be inert when no build command is declared

When no build command is declared, the fix and auto-fix rounds SHALL behave exactly as they do today: the
build command SHALL NOT be run, no amend SHALL occur, and no new failure mode SHALL be introduced.

#### Scenario: Undeclared repo is unchanged

- **WHEN** a fix or auto-fix round produces a commit and no `build_command` is declared
- **THEN** no build command SHALL be run
- **AND** no amend SHALL occur
- **AND** the round SHALL proceed exactly as it did before this capability

### Requirement: The rebuild-and-fold SHALL fold only build-introduced changes and be idempotent

The rebuild-and-fold SHALL run only when the round's post-commit worktree is clean, so any change observed
after the build is attributable to the build command; an unrelated pre-existing dirty path SHALL be left
untouched so the existing dirty-worktree block still fires on it. After a fix round completes on a repo with
a declared build command, re-running the build command against the committed source SHALL produce no diff —
the committed artifacts match what the build produces.

#### Scenario: Unrelated pre-existing dirt is not swept into the build commit

- **WHEN** a fix round commits source but leaves an unrelated uncommitted path (e.g. `core/scripts/foo.ts`)
  so the post-commit worktree is not clean
- **THEN** the rebuild-and-fold SHALL NOT fold that unrelated path into the round commit
- **AND** the existing dirty-worktree block SHALL still fire on the remaining uncommitted path

#### Scenario: Committed artifacts match the build output

- **WHEN** a fix round with a declared build command has folded the build output into its commit
- **THEN** re-running the build command against the committed source SHALL produce no worktree change

### Requirement: The rebuild-and-fold SHALL be injectable and have a biting regression test

The rebuild-and-fold logic SHALL accept injectable seams (a build runner and git status/dirty/add/amend
seams) so unit tests exercise it with fakes and perform no real git, network, or subprocess call. The test
suite SHALL include a regression test that drives "a fix round edits source and the build regenerates a
committed artifact" and asserts the artifact is folded into the round commit and the worktree is clean
afterward. The test SHALL bite: with the rebuild-and-fold removed, the same input SHALL leave the artifact
stale/uncommitted.

#### Scenario: Unit test exercises the rebuild-and-fold path with fakes

- **WHEN** the fake build runner reports it rewrote a `dist/` artifact
- **THEN** the test SHALL assert the artifact is staged and the amend-no-edit committer is called
- **AND** SHALL assert no real git or build subprocess is invoked

#### Scenario: Regression test bites without the rebuild-and-fold

- **WHEN** the rebuild-and-fold step is removed and the same fix round edits source with a declared build
  command that regenerates a committed artifact
- **THEN** the test SHALL observe the artifact remaining stale/uncommitted
- **AND** the test SHALL fail, proving it guards the fix
