# test-build-gate Specification

## Purpose
The test/build gate runs the target repo's own test/build command in the worktree and self-heals failures through a bounded generate→test→fix loop before the item advances. It auto-detects the command, stays non-blocking when none is found, and treats a dirty tree as untrustworthy. (The full-CI-command surface for this repo is refined by `test-gate-ci-parity`; the trailer/commit-message invariants on fix-harness commits are refined by `harness-step-verification`.)
## Requirements
### Requirement: Disabled gate is skipped
When `cfg.test_gate.enabled` is `false`, the gate SHALL return a skipped result immediately without detecting or running any command.

#### Scenario: gate disabled
- **WHEN** `cfg.test_gate.enabled` is `false`
- **THEN** the gate SHALL skip and SHALL NOT invoke any test/build command or fix harness

### Requirement: Command resolution — explicit override, else auto-detection
The command SHALL be the explicit `cfg.test_gate.command` (run via `bash -c` with `set -o pipefail`; the shell parses the string and the pipeline SHALL NOT tokenize it before spawning) when set; otherwise it SHALL be auto-detected with a defined precedence: a real `package.json` `test` script (package manager chosen from the lockfile — `pnpm-lock.yaml`→pnpm, `yarn.lock`→yarn, else npm; a placeholder/echo-only `test` script falls back to a build/typecheck script), then `go.mod`→`go test ./...`, `Cargo.toml`→`cargo test`, a concrete pytest marker→`pytest`, a `Makefile` `test:` target→`make test`. Auto-detected commands SHALL be spawned directly without shell wrapping.

#### Scenario: explicit override bypasses detection
- **WHEN** `cfg.test_gate.command` is set
- **THEN** that command SHALL be executed via `bash -c` with `set -o pipefail` and auto-detection SHALL be skipped

#### Scenario: piped configured command surfaces an early-stage failure
- **WHEN** `cfg.test_gate.command` is a pipeline whose first stage fails but whose last stage succeeds (e.g. `npm test | tee log`)
- **THEN** `set -o pipefail` SHALL cause the overall command to exit non-zero and the gate SHALL block — the failure SHALL NOT be masked by the last stage's exit code

#### Scenario: detect package.json test with pnpm lockfile
- **WHEN** the worktree has a `package.json` `test` script and a `pnpm-lock.yaml`
- **THEN** the detected command SHALL run the test script via pnpm

#### Scenario: placeholder test script falls back
- **WHEN** the `package.json` `test` script is an npm placeholder (`echo "Error: no test specified" && exit 1`)
- **THEN** detection SHALL skip it and fall back to a build/typecheck script if present

### Requirement: Non-blocking when no command is detected
When no command is configured or detected, the gate SHALL skip without blocking — the pipeline stays usable on repos with no test/build command.

#### Scenario: empty repo
- **WHEN** the worktree has no recognized test/build command and no explicit override
- **THEN** the gate SHALL return skipped and SHALL NOT block the item

### Requirement: Worktree must be clean around a trusted run

Before the first run the worktree SHALL be clean of **product-relevant**
uncommitted changes; product dirt SHALL block (attempts 0) because results would
be untrustworthy. Non-product scratch paths classified by the
`test-gate-non-product-dirty` capability (engine-known paths such as
`tasks/todo.md`, `.pipeline-prompt-*`, and
`artifacts/challenge-response-*.json`, plus any configured extensions of that
set) SHALL NOT alone cause this pre-run hard block. After a passing run the tree
SHALL still be free of product-relevant uncommitted artifacts; if the run
produced uncommitted **product** artifacts the gate SHALL block (the committed
state differs from the tested state). Post-run dirt that is exclusively
non-product scratch SHALL NOT alone cause a hard block. Recognized lock-file
side-effects remain out of band: they are folded before gates when applicable
and are not treated as ignorable scratch.

#### Scenario: dirty before the first run

- **WHEN** the worktree has uncommitted **product** changes before the gate runs
- **THEN** the gate SHALL block with attempts 0 and SHALL NOT invoke the fix harness

#### Scenario: scratch-only dirty before the first run is not a hard block

- **WHEN** the worktree’s only uncommitted paths match the non-product scratch
  classification (e.g. `tasks/todo.md` or `artifacts/challenge-response-*.json`)
- **AND** no product path is uncommitted
- **THEN** the gate SHALL NOT hard-block solely for that dirt
- **AND** SHALL proceed to run the test/build command (or restore those scratch
  paths first and then run the command)

#### Scenario: challenge-response dump alone does not refuse the gate (#1013)

- **WHEN** the worktree’s only uncommitted path is
  `artifacts/challenge-response-<N>.json`
- **AND** product paths are clean
- **AND** the test gate evaluates the pre-run dirty trust check
- **THEN** the gate SHALL NOT hard-block solely for that path
- **AND** SHALL NOT classify that hold as test/build fix exhaustion for product
  dirt
- **AND** SHALL proceed to invoke the configured or detected test/build command
  (unless optional restore of that path runs first and then the command is
  invoked)

#### Scenario: passing run leaves product artifacts

- **WHEN** the command exits 0 but leaves the tree dirty with product-relevant paths
- **THEN** the gate SHALL block rather than report success

#### Scenario: passing run leaves only scratch dirt

- **WHEN** the command exits 0
- **AND** the only uncommitted paths match non-product scratch classification
  (including engine-known challenge-response dumps)
- **THEN** the gate SHALL NOT hard-block solely for that scratch
- **AND** SHALL report success for the post-run dirty-trust check

### Requirement: Bounded generate→test→fix loop
On a failing command the gate SHALL enter a loop bounded by `cfg.test_gate.max_attempts`: each attempt invokes the fix harness then re-runs the command; on a pass it returns success; after the attempts are exhausted it SHALL block with the captured output.

#### Scenario: fail then fix then pass
- **WHEN** the command fails initially and the fix harness's change makes the re-run pass
- **THEN** the gate SHALL return passed with the attempt count used

#### Scenario: attempts exhausted
- **WHEN** the command fails on the initial run and after all `max_attempts` fix attempts
- **THEN** the gate SHALL perform exactly `max_attempts` fix-harness invocations and then block with the captured output

### Requirement: Per-run timeout budget
Each command run SHALL be bounded by `cfg.test_gate.timeout` seconds; a timeout SHALL be treated as a failure with a timeout marker appended to the captured output.

#### Scenario: run exceeds the timeout
- **WHEN** a command run exceeds `cfg.test_gate.timeout`
- **THEN** it SHALL be killed and treated as a failed attempt

### Requirement: Test gate assumes worktree is dependency-installed
The test/build gate SHALL assume that the worktree's dependency install step has already completed (as guaranteed by the `worktree-dependency-install` bootstrap). The gate SHALL NOT attempt to detect or run a package manager install itself; if binaries are absent, it SHALL report the failing command output and block — not silently retry with an install.

#### Scenario: binaries available after bootstrap
- **WHEN** the worktree-dependency-install step has run successfully before the test gate executes
- **THEN** the test gate SHALL be able to invoke auto-detected or configured binaries (e.g., `pnpm run test`, `vitest`) without a "command not found" error

#### Scenario: gate does not install dependencies itself
- **WHEN** the test gate detects and runs a command
- **THEN** it SHALL NOT run any package manager install step before invoking the command
- **AND** install responsibility SHALL remain entirely with the worktree bootstrap phase

### Requirement: Dirty-worktree block SHALL name the offending paths

The test/build gate's dirty-worktree block `blockReason` SHALL include the offending paths from
`git status --porcelain`, so the operator can see what is dirty without inspecting the worktree.
This applies to both dirty-tree blocks: the pre-run block (uncommitted changes before the first
trusted run) and the post-run block (a passing run that left the tree dirty). The porcelain path
list SHALL be appended to the existing human-readable reason under a short label (e.g.
`Uncommitted paths:`), and SHALL be truncated via the gate's existing output-cap helper when the
list is long so it cannot blow up the GitHub blocker comment. When the gate does not block on a
dirty tree, the reason SHALL be unchanged. The path-capture seam SHALL be injectable so the path
list is unit-testable without invoking real git.

#### Scenario: dirty before the first run names the paths

- **WHEN** the worktree has uncommitted changes before the gate runs (e.g. an untracked
  `openspec/config.yaml`)
- **THEN** the gate SHALL block with attempts 0 and SHALL NOT invoke the fix harness
- **AND** the `blockReason` SHALL contain the offending path(s) from `git status --porcelain`
  (e.g. a line containing `openspec/config.yaml`)

#### Scenario: passing run leaves artifacts — block names the paths

- **WHEN** the test/build command exits 0 but leaves the tree dirty
- **THEN** the gate SHALL block rather than report success
- **AND** the `blockReason` SHALL contain the offending path(s) from `git status --porcelain`

#### Scenario: long porcelain output is truncated

- **WHEN** the dirty worktree contains a large number of uncommitted paths
- **THEN** the `blockReason` SHALL include the porcelain list truncated to the gate's output cap
- **AND** the truncation SHALL be marked (e.g. a truncation suffix) rather than silently dropped

#### Scenario: path capture is injectable for unit testing

- **WHEN** the gate runs with a fake porcelain-status seam returning a known dirty path list
- **THEN** the test SHALL assert the resulting `blockReason` contains those paths
- **AND** the test SHALL do no real git, network, or subprocess calls

#### Scenario: clean worktree is unaffected

- **WHEN** the worktree is clean before the run and the command passes leaving the tree clean
- **THEN** the gate SHALL pass and SHALL NOT add any porcelain-path text to its result

### Requirement: Gate outcome derives solely from the observed test-command exit code

The test/build gate's pass/fail outcome SHALL be determined solely by the test command's observed
process exit code. A write failure in the run-store event sink, or in any other telemetry /
log-capture write the pipeline performs while the command runs (including a synchronous socket-write
throw such as `EPIPE`), SHALL NOT fail the gate and SHALL NOT terminate or truncate the gate's
outcome determination. Such capture/telemetry write errors SHALL be recorded as non-fatal tooling
diagnostics (logged, as `appendEvent` already does) and SHALL NOT appear as the gate's
`blockReason`. When the command exits 0, the gate SHALL report a pass even if a concurrent
event-sink or log-capture write failed.

#### Scenario: event-sink write failure during a passing run does not fail the gate

- **WHEN** the test/build command runs and exits 0
- **AND** a run-store event-sink delivery write fails (e.g. the forwarder socket returns `EPIPE`)
  while the command is running
- **THEN** the gate SHALL report `{ passed: true }`
- **AND** the sink failure SHALL be recorded as a non-fatal diagnostic
- **AND** the sink failure SHALL NOT be surfaced as the gate's `blockReason`

#### Scenario: capture/telemetry write error never becomes the block reason

- **WHEN** a telemetry or log-capture write fails during the gate but the test command's exit code
  is observed cleanly
- **THEN** the gate outcome SHALL equal the outcome implied by that exit code
- **AND** no capture/telemetry stack trace or write-error text SHALL be used as the `blockReason`

### Requirement: Abnormal output-capture termination is a bounded tooling-failure retry, not a fix attempt

The gate SHALL treat a test-command run that terminates abnormally — one where the pipeline never
observes a clean process exit code (a spawn error or a capture pipe that broke before `close`), as
opposed to a genuine non-zero exit — as a **tooling failure**, and SHALL re-run the same command up
to a bounded number of tooling retries WITHOUT invoking the fix harness. A tooling-failure retry
SHALL NOT decrement or consume the `test_gate.max_attempts` fix budget. Only a cleanly-observed
non-zero exit code SHALL be treated as a genuine test failure that enters the bounded
generate→test→fix loop. If the bounded tooling retries are exhausted without ever observing a clean
exit code, the gate SHALL block with a tooling-failure reason that is distinct from the ordinary
"test/build gate failed after N fix attempt(s)" test-failure reason.

#### Scenario: capture dies before exit observed — command is re-run, fix harness is not invoked

- **WHEN** a test-command run ends without a clean observed exit code (spawn/capture error)
- **THEN** the gate SHALL re-run the same test command
- **AND** SHALL NOT invoke the fix harness for that attempt
- **AND** SHALL NOT decrement or consume `test_gate.max_attempts`

#### Scenario: tooling-failure retry then a clean pass reports a pass with no fix charged

- **WHEN** the first run terminates abnormally (no clean exit observed)
- **AND** a bounded tooling retry then runs the command to a clean exit 0
- **THEN** the gate SHALL report `{ passed: true, attempts: 0 }`
- **AND** SHALL have performed zero fix-harness invocations

#### Scenario: cleanly-observed non-zero exit still enters the fix loop

- **WHEN** a test-command run completes with a cleanly-observed non-zero exit code
- **THEN** the gate SHALL treat it as a genuine test failure
- **AND** SHALL enter the bounded generate→test→fix loop (charging a fix attempt), NOT the
  tooling-failure retry path

#### Scenario: tooling retries exhausted blocks with a distinct tooling-failure reason

- **WHEN** every bounded tooling retry terminates abnormally without a clean observed exit code
- **THEN** the gate SHALL block
- **AND** the `blockReason` SHALL identify the failure as a tooling/capture failure
- **AND** the reason SHALL be distinct from the "test/build gate failed after N fix attempt(s)"
  test-failure message

### Requirement: Test-gate failure excerpt preserves the summary tail

The gate SHALL produce the captured-output failure excerpt used as the `blockReason` with a
tail-biased elision strategy whenever the captured test/build command output exceeds the gate's
block-output cap (`MAX_BLOCK_OUTPUT`) — keeping a leading **head** fragment (command/setup context), an explicit
middle-elision **marker** indicating how much intervening content was dropped, and a trailing
**tail** fragment (where a test runner prints its pass/fail summary) — rather than by keeping only
the leading characters. The head plus tail source characters shown SHALL together not exceed
`MAX_BLOCK_OUTPUT`. When the captured output is at or below `MAX_BLOCK_OUTPUT` characters, the
excerpt SHALL equal the output verbatim with no elision marker added. This mirrors the eval-gate
tail-biased excerpt (#373) so the decisive summary survives truncation instead of the excerpt ending
inside leading boilerplate.

#### Scenario: over-cap failure output keeps the summary tail

- **WHEN** a test-gate failure's captured output exceeds `MAX_BLOCK_OUTPUT` characters and the
  pass/fail summary is in the final characters
- **THEN** the `blockReason` excerpt SHALL contain those final summary characters
- **AND** SHALL contain a leading head fragment followed by a middle-elision marker before the tail
- **AND** the head plus tail source characters shown SHALL not exceed `MAX_BLOCK_OUTPUT`

#### Scenario: at-or-under-cap output is verbatim

- **WHEN** a test-gate failure's captured output is at or below `MAX_BLOCK_OUTPUT` characters
- **THEN** the `blockReason` excerpt SHALL equal the captured output verbatim
- **AND** SHALL NOT contain an elision marker

### Requirement: Dirty-worktree gate failure SHALL NOT be worded as test/build fix exhaustion

The operator-facing block reason for a dirty-worktree-only test/build gate failure SHALL NOT
claim that the test/build gate failed after N fix attempt(s) and SHALL NOT claim that the
repo's own test/build command is still failing. This applies when the gate blocks solely
because the worktree is dirty — either before the first trusted command run (pre-dirty) or
after a passing command that left uncommitted artifacts (post-run dirty) — and the gate has
not entered the generate→test→fix loop as a genuine test failure. The reason SHALL identify
the failure as a dirty-worktree / uncommitted-changes trust refusal (using the gate's dirty
`blockReason` text or an equally accurate pass-through), and SHALL retain path disclosure for
uncommitted paths when that disclosure is already part of the gate result. Genuine command
failures that exhaust `max_attempts` fix attempts SHALL continue to use the existing
exhaustion wording.

#### Scenario: Pre-dirty block is not wrapped as fix exhaustion

- **WHEN** the worktree has uncommitted changes before the gate runs
- **AND** the gate returns a failed result with attempts 0 without invoking the fix harness
- **AND** the pipeline formats that result for an operator-facing blocker
- **THEN** the formatted reason SHALL identify uncommitted changes / dirty worktree as the
  cause
- **AND** the formatted reason SHALL NOT match the pattern of “failed after N fix attempt(s)”
- **AND** the formatted reason SHALL NOT claim that the repo's own test/build command is still
  failing
- **AND** the formatted reason SHALL still include uncommitted path disclosure when the gate
  result carries porcelain paths

#### Scenario: Post-run dirty block is not wrapped as fix exhaustion

- **WHEN** the test/build command exits 0 but leaves the tree dirty
- **AND** the gate blocks with attempts 0 without charging a fix attempt for that dirt
- **AND** the pipeline formats that result for an operator-facing blocker
- **THEN** the formatted reason SHALL identify leftover uncommitted artifacts / dirty tree
- **AND** the formatted reason SHALL NOT claim fix-attempt exhaustion or that the test/build
  command is still failing

#### Scenario: Exhausted real test failures keep exhaustion wording

- **WHEN** the test/build command fails with a cleanly observed non-zero exit
- **AND** fix attempts are exhausted under `test_gate.max_attempts`
- **THEN** the operator-facing block reason SHALL still indicate failure after N fix
  attempt(s) (or equivalent exhaustion wording)
- **AND** that wording SHALL remain distinct from dirty-worktree refusal reasons

#### Scenario: Dirty vs exhaustion distinction is unit-testable without real git

- **WHEN** a unit test constructs a pre-dirty `TestGateResult` (attempts 0, dirty blockReason,
  no fix harness run) and formats it with `testGateBlockReason` (or the equivalent public
  formatter)
- **THEN** the test SHALL assert the output does not claim fix-attempt exhaustion or command
  still failing
- **AND** SHALL assert a real exhausted test-failure result still receives exhaustion wording
- **AND** the test SHALL perform no real git, network, or subprocess call

### Requirement: Pre-run dirty path disclosure SHALL emphasize product paths

The test/build gate `blockReason` SHALL include the offending **product** paths
from porcelain status when the gate hard-blocks because of product-relevant
uncommitted changes (truncated via the existing output-cap helper when long).
Paths classified as non-product scratch MAY be omitted from the blocking
disclosure or listed separately as non-blocking; they SHALL NOT be the sole
paths that cause a hard block. When the gate does not block on a dirty tree, the
reason SHALL be unchanged. Path capture remains injectable for unit testing
without real git.

#### Scenario: product dirty block names product paths

- **WHEN** the worktree has an uncommitted product path before the gate runs
- **THEN** the gate SHALL block with attempts 0
- **AND** the `blockReason` SHALL contain that product path

#### Scenario: mixed dirt does not treat scratch as the sole disclosed failure

- **WHEN** the worktree has both product dirt and non-product scratch dirty
- **THEN** the gate SHALL block
- **AND** the `blockReason` SHALL contain the product path(s)

### Requirement: Test/build gate execution SHALL emit SHA-pinned Tester evidence

The test/build gate path SHALL produce or update a `TesterEvidence` record for
the worktree HEAD SHA via the deterministic producer defined by the
`tester-evidence` capability when the gate runs (or explicitly skips because it
is disabled or no command is resolved) and a run/state directory is available
for recording. Command exit status, timeout, dirty-tree unavailability, and
skip/disable outcomes SHALL map into the Tester status taxonomy rather than
only a free-form `CommandRecord`. Existing gate blocking and fix-loop behavior
SHALL remain authoritative for advance/block routing; the Tester artifact is
the structured evidence form of that execution, not a parallel policy engine.

#### Scenario: passing gate run emits passed Tester evidence

- **WHEN** `runTestGate` completes a trusted clean-tree run that exits 0
- **AND** a run/state directory is provided for recording
- **THEN** a `TesterEvidence` record SHALL exist for the current HEAD SHA with
  `overall_status: "passed"`
- **AND** the resolved command identity SHALL appear in `commands`

#### Scenario: failing gate run emits failed Tester evidence

- **WHEN** the test/build command exits non-zero under a trusted run
- **AND** a run/state directory is provided
- **THEN** the `TesterEvidence` record for that HEAD SHA SHALL have a non-pass
  `overall_status` of `"failed"` (or `"timeout"` / `"tooling_failure"` when so
  classified)
- **AND** bounded redacted output SHALL be retained on the command row

#### Scenario: disabled gate emits disabled evidence when recording is available

- **WHEN** `cfg.test_gate.enabled` is false
- **AND** the producer is invoked with a run/state directory
- **THEN** the emitted `TesterEvidence` SHALL have `overall_status: "disabled"`
- **AND** no test/build command SHALL be executed

#### Scenario: dirty product tree unavailability is explicit

- **WHEN** the gate hard-blocks before running because of product-relevant
  uncommitted changes
- **AND** recording is available
- **THEN** the Tester evidence for that attempt SHALL use `unavailable` (or
  equivalent non-pass) with a reason naming the dirty-tree trust failure
- **AND** SHALL NOT claim `"passed"`

#### Scenario: recording absent remains non-fatal for gate outcome

- **WHEN** unit tests or callers invoke the gate without a state/run directory
- **THEN** the gate outcome (pass/block/skip) SHALL still be computed as today
- **AND** absence of a written artifact SHALL NOT alone invert the gate’s
  pass/fail decision for that in-process call

