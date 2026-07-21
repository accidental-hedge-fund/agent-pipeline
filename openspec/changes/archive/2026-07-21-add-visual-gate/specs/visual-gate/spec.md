# visual-gate delta

## ADDED Requirements

### Requirement: Repo opts in via a visual_gate config block

The pipeline SHALL let a repo opt in to the visual gate by declaring a `visual_gate` block in
`.github/pipeline.yml` with `enabled: true` and a `command` string. The block SHALL accept
`enabled`, `command`, `mode`, `timeout`, `max_attempts`, and `artifacts_dir`, SHALL reject unknown
keys, and SHALL require no per-issue human configuration.

#### Scenario: visual_gate block present with enabled true

- **WHEN** `.github/pipeline.yml` contains `visual_gate.enabled: true` and `visual_gate.command: "<cmd>"`
- **THEN** `PipelineConfig.visual_gate.enabled` SHALL be `true`
- **AND** `PipelineConfig.visual_gate.command` SHALL equal `"<cmd>"`

#### Scenario: visual_gate block absent

- **WHEN** `.github/pipeline.yml` has no `visual_gate` block
- **THEN** `PipelineConfig.visual_gate.enabled` SHALL default to `false`
- **AND** `PipelineConfig.visual_gate.mode` SHALL default to `"gate"`

#### Scenario: unknown key rejected

- **WHEN** the `visual_gate` block contains a key outside the accepted set
- **THEN** config parsing SHALL produce an error diagnostic naming the unknown key

### Requirement: Enabling the visual gate without a command SHALL be a config error

The pipeline SHALL emit an error diagnostic when `visual_gate.enabled` is `true` and
`visual_gate.command` is absent or empty, rather than silently skipping the stage.

#### Scenario: enabled without a command

- **WHEN** `visual_gate.enabled` is `true` and `visual_gate.command` is absent
- **THEN** config validation SHALL produce a diagnostic of severity `error`
- **AND** the stage SHALL NOT be treated as enabled-and-passing

### Requirement: visual_gate.enabled and visual_gate.mode SHALL be rigor-gating config paths

The pipeline SHALL treat `visual_gate.enabled` and `visual_gate.mode` as rigor-gating paths: a
malformed or unrecognized value SHALL produce an error diagnostic and SHALL NOT be silently coerced
to a less rigorous setting (disabled, or advisory).

#### Scenario: malformed enabled value

- **WHEN** `visual_gate.enabled` holds a non-boolean value
- **THEN** config validation SHALL produce a diagnostic of severity `error`
- **AND** the gate SHALL NOT be silently treated as disabled

#### Scenario: malformed mode value

- **WHEN** `visual_gate.mode` holds a value outside `gate` / `advisory`
- **THEN** config validation SHALL produce a diagnostic of severity `error`
- **AND** the mode SHALL NOT be silently coerced to `advisory`

### Requirement: visual-gate is a distinct pipeline stage between pre-merge and eval-gate

The constant `STAGES` SHALL include `"visual-gate"` positioned after `"pre-merge"` and before
`"eval-gate"`. The orchestrator dispatch table SHALL route `"visual-gate"` to the visual stage
handler, and the `pre-merge` stage's success transition SHALL target `visual-gate`.

#### Scenario: STAGES ordering

- **WHEN** the `STAGES` constant is inspected
- **THEN** `"visual-gate"` SHALL appear at an index greater than the index of `"pre-merge"`
- **AND** `"visual-gate"` SHALL appear at an index less than the index of `"eval-gate"`

#### Scenario: dispatch routes visual-gate

- **WHEN** the current stage label is `pipeline:visual-gate`
- **THEN** the orchestrator SHALL call the visual stage handler
- **AND** SHALL NOT call the eval stage handler directly

### Requirement: The pipeline:visual-gate label SHALL be created by init

The `pipeline --init` / `pipeline:init` path SHALL create the `pipeline:visual-gate` label alongside
the other stage labels, and the stage SHALL be represented on an issue by that label through the
normal single-stage-label lifecycle.

#### Scenario: init creates the label

- **WHEN** `pipeline --init` runs against a repo
- **THEN** a `pipeline:visual-gate` label SHALL exist in the repo after the run

### Requirement: The visual-gate stage SHALL be skipped when visual_gate is not enabled

When `visual_gate.enabled` is false (or the block is absent), the `visual-gate` stage SHALL
transition immediately to `eval-gate` with a "step disabled" log line, without invoking any command,
without posting any comment, and without recording any artifacts. A repo that has not opted in SHALL
observe no difference other than that one additional skip log line and the one additional label
transition.

#### Scenario: visual_gate disabled — stage is skipped

- **WHEN** the current stage is `visual-gate`
- **AND** `cfg.visual_gate.enabled` is `false`
- **THEN** the stage SHALL transition to `eval-gate` with a "visual-gate step disabled; skipping." message
- **AND** SHALL NOT spawn any child process
- **AND** SHALL NOT post any comment
- **AND** SHALL NOT record any artifact manifest

#### Scenario: no visual_gate config — item still reaches the same terminal outcome

- **WHEN** `.github/pipeline.yml` has no `visual_gate` block
- **AND** an issue reaches the `visual-gate` stage
- **THEN** the issue SHALL continue through `eval-gate` in the same pipeline invocation
- **AND** no visual-related comment SHALL appear on the issue

### Requirement: The visual command SHALL run in the issue worktree via sh -c

When `visual_gate.enabled` is true, the visual stage SHALL execute `visual_gate.command` as a shell
command through `sh -c` with the issue's worktree directory as the working directory.

#### Scenario: command runs in the worktree

- **WHEN** the current stage is `visual-gate` and `cfg.visual_gate.enabled` is `true`
- **THEN** the stage SHALL resolve the worktree path for the issue
- **AND** SHALL execute `cfg.visual_gate.command` through `sh -c` with that path as the working directory

### Requirement: The visual command SHALL receive PR, branch, issue, run, and artifacts context in its environment

The stage SHALL export `PIPELINE_PR_NUMBER`, `PIPELINE_BRANCH`, `PIPELINE_ISSUE`, `PIPELINE_RUN_ID`,
and `PIPELINE_VISUAL_ARTIFACTS_DIR` (an absolute path) into the command's environment, so a
repo-defined suite can locate and target its per-PR preview deployment instead of only a locally
served build. The rest of the pipeline process environment SHALL be inherited unchanged, and the
pipeline SHALL NOT itself fetch, construct, or validate any preview-deployment URL.

#### Scenario: run context is exported

- **WHEN** the visual command is invoked for issue `N` on branch `B` with PR `P` in run `R`
- **THEN** the command's environment SHALL contain `PIPELINE_ISSUE=N`, `PIPELINE_BRANCH=B`,
  `PIPELINE_PR_NUMBER=P`, and `PIPELINE_RUN_ID=R`
- **AND** SHALL contain `PIPELINE_VISUAL_ARTIFACTS_DIR` set to the absolute artifacts directory

#### Scenario: pipeline does not resolve preview URLs

- **WHEN** the visual command targets a per-PR preview deployment
- **THEN** the pipeline SHALL NOT issue any deployment-provider request on the command's behalf
- **AND** the exit code SHALL remain the sole verdict

### Requirement: Exit code SHALL determine pass/fail; the pipeline SHALL NOT interpret visual output

The visual stage SHALL treat exit code 0 from the command as a pass and any non-zero exit code as a
fail. The pipeline SHALL NOT parse the command output, compare screenshots, or compute any
visual-regression score; that responsibility belongs entirely to the repo-defined command.

#### Scenario: exit 0 — pass

- **WHEN** the visual command exits with code 0
- **THEN** the stage SHALL produce a pass outcome

#### Scenario: non-zero exit — fail

- **WHEN** the visual command exits with any non-zero code
- **THEN** the stage SHALL produce a fail outcome

#### Scenario: no image comparison is performed

- **WHEN** the artifacts directory contains screenshots or diff images
- **THEN** the stage SHALL NOT decode or compare them
- **AND** the pass/fail outcome SHALL depend only on the exit code

### Requirement: Visual artifacts SHALL be captured and recorded as evidence

The stage SHALL, after each command run, enumerate the files under the configured
`visual_gate.artifacts_dir` (worktree-relative, default `.pipeline-visual`), copy them into the run
directory so they survive worktree cleanup, and record a deterministic relative-path manifest in the
issue's evidence bundle. Enumeration SHALL be bounded by a maximum file count and total size, and
SHALL note explicitly when the listing was truncated. A path that resolves outside the worktree root
SHALL be rejected with an error rather than read.

#### Scenario: artifacts captured and manifested

- **WHEN** the visual command writes screenshots into `artifacts_dir`
- **THEN** the stage SHALL copy those files into the run directory
- **AND** SHALL record their relative paths as an artifact manifest in the evidence bundle

#### Scenario: missing or empty artifacts directory

- **WHEN** `artifacts_dir` does not exist or contains no files after the run
- **THEN** the stage SHALL record an explicit "no artifacts captured" note
- **AND** the pass/fail outcome SHALL be unchanged by the absence

#### Scenario: bounded enumeration

- **WHEN** the artifacts directory exceeds the file-count or total-size bound
- **THEN** the manifest SHALL list the bounded subset
- **AND** SHALL state that the listing was truncated

#### Scenario: path escaping the worktree is rejected

- **WHEN** `visual_gate.artifacts_dir` resolves outside the issue worktree root
- **THEN** the stage SHALL produce an error diagnostic
- **AND** SHALL NOT read or copy files from that location

### Requirement: The visual outcome SHALL be posted as an issue comment with the artifact manifest

After each visual run (pass or fail, gate or advisory), the stage SHALL post a `## Visual Gate`
comment on the issue containing: mode, outcome (PASS/FAIL), elapsed time, an excerpt of the combined
stdout/stderr bounded by the tail-biased excerpt strategy (head portion, explicit middle-elision
marker, summary tail), and the artifact manifest (or the "no artifacts captured" note). Output and
manifest content SHALL pass through the existing secret-redaction sanitizer before posting.

#### Scenario: comment posted on pass

- **WHEN** the visual command exits 0
- **THEN** a comment beginning with `## Visual Gate` SHALL be posted on the issue
- **AND** the comment SHALL state the outcome as PASS
- **AND** the comment SHALL include elapsed time, a bounded output excerpt, and the artifact manifest

#### Scenario: comment posted on fail

- **WHEN** the visual command exits non-zero
- **THEN** a comment beginning with `## Visual Gate` SHALL be posted on the issue
- **AND** the comment SHALL state the outcome as FAIL
- **AND** the comment SHALL include elapsed time, a bounded output excerpt, and the artifact manifest

#### Scenario: over-limit output keeps the summary tail

- **WHEN** the combined output exceeds the comment output bound
- **THEN** the excerpt SHALL contain the final characters of the output
- **AND** SHALL contain a leading head portion followed by an explicit middle-elision marker

#### Scenario: secrets are redacted

- **WHEN** the command output contains a value matching the secret-redaction patterns
- **THEN** the posted comment SHALL contain the redacted form

### Requirement: Gate mode SHALL block on failure; advisory mode SHALL never block

The `visual_gate.mode` config key SHALL control blocking behavior. In `gate` mode (default) an
ordinary non-zero exit (not a timeout, not a spawn/runner error) SHALL first route through a bounded
fix round while attempts remain, and SHALL call `setBlocked` without advancing only after the
`visual_gate.max_attempts` budget is exhausted (or immediately when `max_attempts` is `1`). In
`advisory` mode the stage SHALL record the result comment and SHALL transition to `eval-gate`
regardless of exit code, and SHALL NOT route to a fix round.

#### Scenario: gate mode + pass with no unreviewed visual-fix commit — advances

- **WHEN** mode is `"gate"` (or absent/default) and the visual command exits 0
- **AND** no visual-fix commit has landed on the PR since the last reviewed SHA
- **THEN** the stage SHALL transition to `eval-gate`

#### Scenario: gate mode + fail with budget remaining — routes to a fix round

- **WHEN** mode is `"gate"` and the visual command exits non-zero (not a timeout, not a spawn error)
- **AND** at least one attempt remains under `visual_gate.max_attempts`
- **THEN** the stage SHALL invoke the implementer harness
- **AND** SHALL NOT call `setBlocked` on this failure

#### Scenario: gate mode + fail with budget exhausted — blocks

- **WHEN** mode is `"gate"` and the visual command exits non-zero after `max_attempts` is exhausted
- **THEN** the stage SHALL call `setBlocked` on the issue with the final visual output
- **AND** SHALL NOT transition to `eval-gate`

#### Scenario: advisory mode + fail — records result and advances

- **WHEN** mode is `"advisory"` and the visual command exits non-zero
- **THEN** the stage SHALL post the visual result comment
- **AND** SHALL transition to `eval-gate`
- **AND** SHALL NOT invoke the implementer harness
- **AND** SHALL NOT call `setBlocked`

#### Scenario: advisory mode + pass — advances normally

- **WHEN** mode is `"advisory"` and the visual command exits 0
- **THEN** the stage SHALL post the visual result comment
- **AND** SHALL transition to `eval-gate`

### Requirement: The visual-fix prompt SHALL receive the gate identity, command, and bounded output

The stage SHALL include in the visual-fix prompt, as explicit context fields, the identity of the
failed gate (`visual-gate`), the configured `visual_gate.command` string, the combined stdout/stderr
bounded by the tail-biased excerpt, and the artifact manifest paths so the harness can open the
captured screenshots in the worktree. The harness SHALL NOT be invoked to fix blind.

#### Scenario: fix prompt names the gate, command, output, and artifacts

- **WHEN** the stage builds the visual-fix prompt for a gate-mode failure
- **THEN** the prompt SHALL identify the failed gate as the visual gate
- **AND** SHALL include the configured `visual_gate.command` string
- **AND** SHALL include the combined output bounded by the tail-biased excerpt
- **AND** SHALL include the captured artifact paths

### Requirement: The visual command SHALL re-run against the fixed code after a pushed fix

The stage SHALL, after a fix round produces a verified fix commit and pushes it, re-run the visual
command against the updated worktree before deciding the next outcome. The command SHALL NOT be
re-run until a fix commit has been verified and pushed.

#### Scenario: visual command re-runs after the fix is pushed

- **WHEN** a fix round commits a fix and the push succeeds
- **THEN** the stage SHALL re-run `visual_gate.command` in the worktree
- **AND** SHALL evaluate the re-run result for pass/fail/tooling exactly as a first run

### Requirement: A visual-fix commit SHALL be routed back through pre-merge review before advancing

The stage SHALL, when the visual command passes while a visual-fix commit sits on the PR that has
not yet cleared pre-merge review, transition the issue to `pre-merge` instead of advancing to
`eval-gate`. This SHALL be determined durably from GitHub PR state (the last reviewed SHA recorded
on a trusted review comment, and whether a commit matching the prescribed visual-fix message format
landed since that SHA) rather than from an in-memory flag scoped to a single invocation. A pass with
no such unreviewed commit SHALL advance directly, unaffected.

#### Scenario: fix-round pass routes to pre-merge

- **WHEN** a fix round pushes a commit and the re-run visual command exits 0
- **THEN** the stage SHALL transition to `pre-merge`
- **AND** SHALL NOT transition directly to `eval-gate`

#### Scenario: pass following a fix commit pushed in an earlier interrupted invocation still routes to pre-merge

- **WHEN** a visual-fix commit was pushed in a prior invocation interrupted before the transition ran
- **AND** a later invocation's visual pass follows, with no fix round in that later invocation
- **THEN** the stage SHALL still transition to `pre-merge`, derived from GitHub PR state

### Requirement: The visual fix-round budget SHALL reuse visual_gate.max_attempts

The stage SHALL govern the fix-round budget with the existing `visual_gate.max_attempts` config
rather than a new key. `max_attempts` SHALL bound the total number of visual command runs; in `gate`
mode each run after the first SHALL be preceded by exactly one fix round, so fix rounds number at
most `max_attempts − 1`. When `max_attempts` is `1` the stage SHALL perform no fix round and SHALL
block on the first gate-mode failure.

#### Scenario: max_attempts bounds the fix rounds

- **WHEN** `visual_gate.max_attempts` is `2` and the visual command keeps failing in `gate` mode
- **THEN** the stage SHALL invoke at most one fix round
- **AND** SHALL block after the second failing run

#### Scenario: max_attempts of 1 performs no fix round

- **WHEN** `visual_gate.max_attempts` is `1` and the visual command fails in `gate` mode
- **THEN** the stage SHALL NOT invoke the implementer harness
- **AND** SHALL call `setBlocked` on the first failure

### Requirement: The visual step SHALL be time-bounded and tooling failures SHALL block immediately

The stage SHALL enforce a hard timeout of `visual_gate.timeout` seconds (default 900) on each
command run. A timeout or a spawn/runner error SHALL be treated as a tooling failure that blocks
immediately with a "visual-gate timed out or errored" message regardless of mode, SHALL NOT trigger
a fix round, and SHALL NOT be retried — the harness being unable to run is not a code regression.

#### Scenario: timeout kills the command and blocks

- **WHEN** the visual command runs longer than `visual_gate.timeout` seconds
- **THEN** the child process SHALL be terminated
- **AND** the stage SHALL call `setBlocked` regardless of mode
- **AND** SHALL NOT trigger a fix round

#### Scenario: spawn/runner error blocks immediately regardless of mode

- **WHEN** the visual command cannot be executed (spawn/runner error)
- **THEN** the stage SHALL call `setBlocked`
- **AND** SHALL NOT trigger a fix round
- **AND** SHALL NOT re-run the command

### Requirement: The visual step SHALL never merge or deploy

The visual stage SHALL only run the configured command, capture artifacts, record the result, and
make a label/comment transition (plus, in `gate` mode, the bounded fix-round commit). It SHALL NOT
create or merge pull requests, nor deploy any artifact.

#### Scenario: visual stage does not touch the merge surface

- **WHEN** the visual stage runs (pass or fail)
- **THEN** no `gh pr merge` or deploy command SHALL be invoked by the stage

### Requirement: The documented state machine SHALL place visual-gate before eval-gate

The README SHALL document `visual-gate` in the Lifecycle section, the stage table, and the
`.github/pipeline.yml` config scaffold, positioned between `pre-merge` and `eval-gate` so the prose
and the state-machine infographic agree. The gate documentation SHALL include an example of
targeting a per-PR preview deployment using the exported run context, and the pattern of supplying
seeded test credentials through the command's environment for auth-protected browser verification.

#### Scenario: README lists the stage in the right position

- **WHEN** the README lifecycle/stage documentation is read
- **THEN** `visual-gate` SHALL appear after `pre-merge` and before `eval-gate`
- **AND** the documented order SHALL match the state-machine infographic

#### Scenario: README documents preview-deployment and auth patterns

- **WHEN** the README visual-gate documentation is read
- **THEN** it SHALL show a command example using `PIPELINE_PR_NUMBER` / `PIPELINE_BRANCH` to target a
  per-PR preview deployment
- **AND** it SHALL describe supplying seeded test credentials via the command's environment for
  auth-protected pages
