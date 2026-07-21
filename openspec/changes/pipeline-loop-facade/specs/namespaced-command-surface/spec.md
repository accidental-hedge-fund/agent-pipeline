## MODIFIED Requirements

### Requirement: Each in-scope operation SHALL be exposed as a distinct `pipeline:<command>` host entry

The host packaging SHALL expose each in-scope pipeline operation as its own
discoverable `pipeline:<command>` command entry, rather than as a flag on a single
`/pipeline` command. The in-scope operation set SHALL be exactly: `status`,
`unblock`, `override`, `summary`, `doctor`, `init`, `cleanup`, `intake`, `sweep`,
`triage`, `merge`, `release`, `roadmap`, `logs`, `loop`. On the Claude host these
entries SHALL be invocable as `/pipeline:<command>`; on the Codex host they SHALL be
invocable as `$pipeline:<command>`. Each entry SHALL appear in that host's
command/skill discovery surface.

#### Scenario: Every in-scope operation has a host command entry

- **WHEN** the host command surface generated for Claude is enumerated
- **THEN** it SHALL contain a `pipeline:status`, `pipeline:unblock`,
  `pipeline:override`, `pipeline:summary`, `pipeline:doctor`, `pipeline:init`,
  `pipeline:cleanup`, `pipeline:intake`, `pipeline:sweep`, `pipeline:triage`,
  `pipeline:merge`, `pipeline:release`, `pipeline:roadmap`, `pipeline:logs`, and
  `pipeline:loop` entry
- **AND** no in-scope operation SHALL be reachable only as a flag on the base
  `/pipeline` command

#### Scenario: A migrated operation is discoverable in the menu

- **WHEN** a developer opens the Claude Code skill/command menu
- **THEN** `pipeline:status` (and each other in-scope entry) SHALL be listed as a
  named command with its own description, without the developer needing to know
  any flag syntax

#### Scenario: The loop entry is generated from the same single source

- **WHEN** `loop` is present in the single-source operation list and
  `scripts/build.mjs` is run
- **THEN** the Claude `commands/` surface SHALL gain `pipeline:loop.md` and the Codex
  overlay SHALL gain the matching agent entry
- **AND** the `plugin/` mirror SHALL regenerate to match

---

### Requirement: Each `pipeline:<command>` entry SHALL forward to the equivalent CLI invocation

Each host command entry SHALL forward to the underlying pipeline CLI invocation
for that operation, preserving the operation's existing behavior, arguments, and
output. The mapping SHALL be: `pipeline:status <N>` → the read-only status mode;
`pipeline:unblock <N> "<answer>"` → post-answer/clear-blocked; `pipeline:override
<N> "<spec>"` → disposition-and-resume; `pipeline:summary <N>` → issue N's
evidence-bundle dump; `pipeline:doctor` → standalone preflight; `pipeline:init` →
label-ensure + config scaffold; `pipeline:cleanup` → merged-worktree sweep; and
`pipeline:<intake|sweep|triage|merge|release|roadmap|logs>` → the existing
identically-named keyword sub-command.

`pipeline:loop` is the single documented exception: it is a **delegating** entry
rather than a CLI forward. It SHALL normalize its arguments and run the deterministic
loop preflight in the pipeline CLI, then hand off durable orchestration to the
installed goal-loop skill. It SHALL NOT be expected to map onto a `pipeline <op>`
keyword sub-command, and the host-surface drift guard SHALL account for it as a
delegating entry.

#### Scenario: Host entry runs the same operation as the underlying command

- **WHEN** `/pipeline:status 42` is invoked
- **THEN** it SHALL produce the same stage/blocker/PR/last-review status output as
  the pre-existing read-only status mode for issue 42
- **AND** it SHALL NOT advance any pipeline stage label

#### Scenario: Issue-bundle summary entry targets the issue number

- **WHEN** `/pipeline:summary 42` is invoked
- **THEN** it SHALL print issue 42's evidence bundle (the per-issue dump), and the
  pre-existing `pipeline summary <run-id>` exact-run selector SHALL remain
  available and unchanged for run-id selection

#### Scenario: The loop entry delegates instead of forwarding

- **WHEN** `/pipeline:loop --milestone v2` is invoked
- **THEN** the deterministic loop preflight SHALL run in the pipeline CLI
- **AND** durable orchestration SHALL be carried out by the installed goal-loop skill,
  not by a `pipeline loop` keyword sub-command owning its own state
