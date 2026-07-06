# eval-gate Specification

## Purpose
TBD - created by archiving change add-eval-gate. Update Purpose after archive.
## Requirements
### Requirement: Repo opts in via eval_gate config block
A repo opts in to the eval gate by declaring an `eval_gate` block in `.github/pipeline.yml` with `enabled: true` and a `command` string. The pipeline SHALL auto-detect this block on every run and require no per-issue human configuration.

#### Scenario: eval_gate block present with enabled true
- **WHEN** `.github/pipeline.yml` contains `eval_gate.enabled: true` and `eval_gate.command: "<cmd>"`
- **THEN** `PipelineConfig.eval_gate.enabled` SHALL be `true`
- **AND** `PipelineConfig.eval_gate.command` SHALL equal `"<cmd>"`

#### Scenario: eval_gate block absent
- **WHEN** `.github/pipeline.yml` has no `eval_gate` block
- **THEN** `PipelineConfig.eval_gate.enabled` SHALL default to `false`

#### Scenario: eval_gate.enabled false
- **WHEN** `.github/pipeline.yml` contains `eval_gate.enabled: false`
- **THEN** `PipelineConfig.eval_gate.enabled` SHALL be `false`

---

### Requirement: eval-gate is a distinct pipeline stage between pre-merge and ready-to-deploy
The constant `STAGES` SHALL include `"eval-gate"` positioned after `"pre-merge"` and before `"ready-to-deploy"`. The orchestrator dispatch table SHALL route `"eval-gate"` to the eval stage handler.

#### Scenario: STAGES ordering
- **WHEN** the `STAGES` constant is inspected
- **THEN** `"eval-gate"` SHALL appear at an index greater than the index of `"pre-merge"`
- **AND** `"eval-gate"` SHALL appear at an index less than the index of `"ready-to-deploy"`

#### Scenario: dispatch routes eval-gate
- **WHEN** the current stage label is `pipeline:eval-gate`
- **THEN** the orchestrator SHALL call the eval stage handler
- **AND** SHALL NOT call `deployReady.finalize()` directly

---

### Requirement: eval-gate stage is skipped when eval_gate is not enabled
When `eval_gate.enabled` is false (or the config block is absent), the `eval-gate` stage SHALL transition immediately to `ready-to-deploy` with a "step disabled" log line, without invoking any eval command and without posting any comment.

#### Scenario: eval_gate disabled — stage is skipped
- **WHEN** the current stage is `eval-gate`
- **AND** `cfg.eval_gate.enabled` is `false`
- **THEN** the stage SHALL call `transition(cfg, issueNumber, "eval-gate", "ready-to-deploy", "eval-gate step disabled; skipping.")`
- **AND** SHALL NOT spawn any child process
- **AND** SHALL NOT post any comment

---

### Requirement: eval command runs in the issue worktree
When `eval_gate.enabled` is true, the eval stage SHALL run `eval_gate.command` as a shell command inside the issue's worktree directory.

#### Scenario: command runs in worktree
- **WHEN** the current stage is `eval-gate`
- **AND** `cfg.eval_gate.enabled` is `true`
- **THEN** the stage SHALL resolve the worktree path via `getForIssue(cfg, issueNumber)`
- **AND** SHALL execute `cfg.eval_gate.command` with the worktree path as the working directory

---

### Requirement: exit code determines pass/fail; pipeline does not interpret scores
The eval stage SHALL treat exit code 0 from the eval command as a pass and any non-zero exit code as a fail. The pipeline SHALL NOT parse or threshold any numeric scores in the command output; that responsibility belongs entirely to the eval harness.

#### Scenario: exit 0 — pass
- **WHEN** the eval command exits with code 0
- **THEN** the stage SHALL produce a pass outcome

#### Scenario: non-zero exit — fail
- **WHEN** the eval command exits with any non-zero code
- **THEN** the stage SHALL produce a fail outcome

---

### Requirement: gate mode blocks on fail; advisory mode never blocks
The `eval_gate.mode` config key SHALL control blocking behavior. In `gate` mode (default) the stage SHALL call `setBlocked` on fail and SHALL NOT advance. In `advisory` mode the stage SHALL record the result comment and SHALL transition to `ready-to-deploy` regardless of exit code.

#### Scenario: gate mode + pass — advances to ready-to-deploy
- **WHEN** mode is `"gate"` (or absent/default)
- **AND** the eval command exits 0
- **THEN** the stage SHALL transition to `ready-to-deploy`

#### Scenario: gate mode + fail — blocks
- **WHEN** mode is `"gate"` (or absent/default)
- **AND** the eval command exits non-zero
- **THEN** the stage SHALL call `setBlocked` on the issue
- **AND** SHALL NOT transition to `ready-to-deploy`

#### Scenario: advisory mode + fail — records result and advances
- **WHEN** mode is `"advisory"`
- **AND** the eval command exits non-zero
- **THEN** the stage SHALL post the eval result comment
- **AND** SHALL transition to `ready-to-deploy`
- **AND** SHALL NOT call `setBlocked`

#### Scenario: advisory mode + pass — advances normally
- **WHEN** mode is `"advisory"`
- **AND** the eval command exits 0
- **THEN** the stage SHALL post the eval result comment
- **AND** SHALL transition to `ready-to-deploy`

---

### Requirement: eval outcome is recorded on the issue/PR as a comment

After each eval run (pass or fail, gate or advisory), the stage SHALL post a `## Eval Gate` comment on the issue containing: mode, outcome (PASS/FAIL), elapsed time, and an excerpt of the combined stdout/stderr output bounded to `MAX_COMMENT_OUTPUT` (2000) source characters. When the output exceeds the bound the excerpt SHALL be produced by the tail-biased elision strategy defined in "Output excerpts preserve the summary tail", not by keeping only the leading characters.

#### Scenario: comment posted on pass

- **WHEN** the eval command exits 0
- **THEN** a comment beginning with `## Eval Gate` SHALL be posted on the issue
- **AND** the comment SHALL state the outcome as PASS
- **AND** the comment SHALL include elapsed time and a stdout excerpt bounded to ≤2000 source characters

#### Scenario: comment posted on fail

- **WHEN** the eval command exits non-zero
- **THEN** a comment beginning with `## Eval Gate` SHALL be posted on the issue
- **AND** the comment SHALL state the outcome as FAIL
- **AND** the comment SHALL include elapsed time and a stdout/stderr excerpt bounded to ≤2000 source characters

### Requirement: step is time-bounded with transient-error retry
The eval stage SHALL enforce a hard timeout of `eval_gate.timeout` seconds (default 300). If the command exceeds the timeout, it is killed and counts as a fail. The stage SHALL retry up to `eval_gate.max_attempts` times (default 2) on transient failure (non-zero exit or timeout). After exhausting retries, the stage SHALL call `setBlocked` with an "eval-gate timed out or errored" message, regardless of mode.

#### Scenario: timeout kills the command and counts as fail
- **WHEN** the eval command runs longer than `eval_gate.timeout` seconds
- **THEN** the child process SHALL be terminated
- **AND** the result SHALL be treated as a fail (non-zero exit)

#### Scenario: retry on transient fail — passes on second attempt
- **WHEN** the first eval attempt exits non-zero
- **AND** `max_attempts` is 2
- **AND** the second attempt exits 0
- **THEN** the stage SHALL produce a pass outcome

#### Scenario: retries exhausted — blocks regardless of mode
- **WHEN** all `max_attempts` attempts fail or time out
- **THEN** the stage SHALL call `setBlocked` with a message describing the eval error
- **AND** SHALL NOT transition to `ready-to-deploy`

---

### Requirement: repos with no eval declaration are completely unaffected
When `eval_gate.enabled` is false (or the block is absent), the pipeline behavior SHALL be identical to today's behavior — the `eval-gate` stage is skipped and the item advances through `pre-merge` → `eval-gate` (skipped) → `ready-to-deploy` with no observable difference to the user other than one additional skip log line.

#### Scenario: no eval_gate config — pipeline behaves as before
- **WHEN** `.github/pipeline.yml` has no `eval_gate` block
- **AND** an issue reaches the `eval-gate` stage
- **THEN** the stage SHALL skip immediately
- **AND** the issue SHALL transition to `ready-to-deploy` in the same pipeline invocation
- **AND** no eval-related comment SHALL appear on the issue

---

### Requirement: eval step never merges or deploys
The eval stage SHALL only run the eval command, record the result, and make a label/comment transition. It SHALL NOT push any commits, create or merge pull requests, or deploy any artifact.

#### Scenario: eval stage does not mutate git or GitHub merge state
- **WHEN** the eval stage runs (pass or fail)
- **THEN** no `git push`, `gh pr merge`, or deploy command SHALL be invoked by the stage

### Requirement: Output excerpts preserve the summary tail

When the combined eval output exceeds `MAX_COMMENT_OUTPUT` characters, the excerpt posted to the issue SHALL preserve the **tail** of the output (where eval harnesses print their pass/fail summary) rather than only the leading characters. The excerpt SHALL also include a leading **head** portion (command-invocation and setup context) followed by an explicit middle-elision marker before the tail portion. The marker SHALL indicate that intervening content was dropped (for example, by stating the number of characters removed) so the reader knows the excerpt is not contiguous. The head and tail source characters shown SHALL together not exceed `MAX_COMMENT_OUTPUT`; the marker text itself is not counted against that budget.

When the combined output is at or below `MAX_COMMENT_OUTPUT` characters, the excerpt SHALL equal the output verbatim with no elision marker added.

#### Scenario: over-limit output keeps the end-of-run summary

- **WHEN** the eval output exceeds `MAX_COMMENT_OUTPUT` characters
- **AND** the pass/fail summary appears in the final characters of the output
- **THEN** the posted excerpt SHALL contain those final characters (the summary tail)
- **AND** the posted excerpt SHALL contain a leading head portion followed by a middle-elision marker before the tail portion
- **AND** the head plus tail source characters shown SHALL not exceed `MAX_COMMENT_OUTPUT`

#### Scenario: within-limit output is unchanged

- **WHEN** the eval output is at or below `MAX_COMMENT_OUTPUT` characters
- **THEN** the posted excerpt SHALL equal the output verbatim
- **AND** no elision marker SHALL be added

### Requirement: Tail-biased excerpting is uniform across all failure paths

The tail-biased excerpting strategy SHALL be applied identically to every path that posts eval output: gate-mode failure, advisory-mode failure, timeout failure, and spawn/runner error. No failure path SHALL keep only the leading characters of the output.

#### Scenario: gate-mode failure uses tail-biased excerpt

- **WHEN** the eval command fails in `gate` mode and its output exceeds `MAX_COMMENT_OUTPUT`
- **THEN** the blocking message SHALL contain the output's summary tail via the tail-biased excerpt

#### Scenario: advisory-mode failure uses tail-biased excerpt

- **WHEN** the eval command fails in `advisory` mode and its output exceeds `MAX_COMMENT_OUTPUT`
- **THEN** the recorded result comment SHALL contain the output's summary tail via the tail-biased excerpt

#### Scenario: timeout failure uses tail-biased excerpt

- **WHEN** the eval command times out and its captured output exceeds `MAX_COMMENT_OUTPUT`
- **THEN** the timeout blocking message SHALL contain the output's summary tail via the tail-biased excerpt

#### Scenario: spawn/runner error uses tail-biased excerpt

- **WHEN** the eval command cannot be executed (spawn/runner error) and its captured output exceeds `MAX_COMMENT_OUTPUT`
- **THEN** the runner-error blocking message SHALL contain the output's summary tail via the tail-biased excerpt

