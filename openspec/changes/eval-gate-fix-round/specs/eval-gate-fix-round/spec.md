## ADDED Requirements

### Requirement: A gate-mode eval failure with remaining budget SHALL route to a fix round

The eval gate SHALL, on an ordinary non-zero exit in `gate` mode when fix attempts remain, invoke
the implementer harness to attempt a fix instead of calling `setBlocked`. An "ordinary" failure is a
non-zero exit that is NOT a timeout and NOT a spawn/runner error. The routing decision SHALL apply
only in `gate` mode; advisory-mode failures and tooling failures SHALL NOT route to a fix round (see
the separate requirements below).

#### Scenario: gate-mode ordinary failure with attempts remaining — fix round is invoked

- **WHEN** the eval command exits non-zero (not a timeout, not a spawn error) in `gate` mode
- **AND** at least one eval attempt remains under `eval_gate.max_attempts`
- **THEN** the stage SHALL invoke the implementer harness with the eval-fix prompt
- **AND** SHALL NOT call `setBlocked` on this failure

#### Scenario: gate-mode ordinary failure on the last attempt — no fix round

- **WHEN** the eval command exits non-zero in `gate` mode
- **AND** no eval attempt remains under `eval_gate.max_attempts`
- **THEN** the stage SHALL NOT invoke the implementer harness
- **AND** SHALL block with the final eval output (see the terminal-block requirement)

---

### Requirement: The eval-fix prompt SHALL receive the eval-gate output as explicit context

The eval-fix prompt SHALL include, as an explicit context field, the identity of the failed gate
(`eval-gate`), the eval command string (`eval_gate.command`), and the combined stdout/stderr the
command produced, bounded to a reasonable size limit using the stage's tail-biased excerpt so the
pass/fail summary at the end of the output is preserved. The harness SHALL therefore know which gate
failed, what command ran, and what it produced — it SHALL NOT be invoked to fix blind.

#### Scenario: fix prompt names the gate, command, and output

- **WHEN** the stage builds the eval-fix prompt for a gate-mode failure
- **THEN** the prompt SHALL identify the failed gate as the eval gate
- **AND** SHALL include the configured `eval_gate.command` string
- **AND** SHALL include the combined stdout/stderr output, bounded by the tail-biased excerpt

#### Scenario: over-limit eval output keeps the summary tail in the fix prompt

- **WHEN** the eval output exceeds the prompt's size bound
- **AND** the pass/fail summary appears in the final characters of the output
- **THEN** the excerpt injected into the fix prompt SHALL contain those final characters

---

### Requirement: The eval command SHALL re-run against the fixed code after a pushed fix

After a fix round produces a verified fix commit and pushes it, the eval gate SHALL re-run the eval
command against the updated worktree code before deciding the next outcome. The eval command SHALL
NOT be re-run until a fix commit has been verified and pushed.

#### Scenario: eval re-runs after the fix is pushed

- **WHEN** a fix round commits a fix and the push succeeds
- **THEN** the stage SHALL re-run `eval_gate.command` in the worktree
- **AND** SHALL evaluate the re-run result for pass/fail/tooling exactly as a first run

#### Scenario: re-run eval passes — item advances normally

- **WHEN** the re-run eval command exits 0
- **THEN** the stage SHALL transition to the configured next stage (`shipcheck-gate` when opted in,
  else `ready-to-deploy`)
- **AND** SHALL use the same advance path as a first-try pass

---

### Requirement: The eval fix-round budget SHALL reuse eval_gate.max_attempts

The eval fix-round budget SHALL be governed by the existing `eval_gate.max_attempts` config, not a
new config key. `eval_gate.max_attempts` SHALL continue to bound the total number of eval command
runs; in `gate` mode each run after the first SHALL be preceded by exactly one fix round, so the
number of fix rounds is at most `eval_gate.max_attempts − 1`. When `eval_gate.max_attempts` is `1`
the stage SHALL perform no fix round and SHALL block on the first gate-mode failure.

#### Scenario: max_attempts bounds the fix rounds

- **WHEN** `eval_gate.max_attempts` is `2` and the eval command keeps failing in `gate` mode
- **THEN** the stage SHALL perform exactly one fix round (one harness invocation) before blocking
- **AND** SHALL run the eval command at most twice

#### Scenario: max_attempts of 1 performs no fix round

- **WHEN** `eval_gate.max_attempts` is `1`
- **AND** the eval command exits non-zero in `gate` mode
- **THEN** the stage SHALL NOT invoke the implementer harness
- **AND** SHALL block on the first failure

---

### Requirement: An eval-fix round SHALL block on failure without pushing a partial fix

An eval-fix round SHALL reuse the fix/test-gate failure contract. If the fix harness errors or times
out, produces no new commit (after salvage of uncommitted work), leaves the worktree dirty, or the
push of the fix commit fails, the stage SHALL block the item and SHALL NOT push a partial fix. A
harness/commit failure SHALL block with kind `harness-failure`; a failed push SHALL block with kind
`push-failed`. The eval command SHALL NOT be re-run after a failed fix round.

#### Scenario: fix harness fails — block, no partial push

- **WHEN** the fix-round harness invocation fails or times out
- **THEN** the stage SHALL set `blocked` with kind `harness-failure`
- **AND** SHALL NOT push any commit
- **AND** SHALL NOT re-run the eval command

#### Scenario: fix produced no new commit — block

- **WHEN** the fix-round harness reports success but produces no new commit and salvage finds nothing
- **THEN** the stage SHALL set `blocked` with kind `harness-failure`
- **AND** SHALL NOT re-run the eval command

#### Scenario: push of the fix commit fails — block

- **WHEN** the fix commit is created but `git push` fails
- **THEN** the stage SHALL set `blocked` with kind `push-failed`
- **AND** SHALL NOT re-run the eval command
