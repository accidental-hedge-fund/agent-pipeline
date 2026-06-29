## ADDED Requirements

### Requirement: Each in-scope operation SHALL be exposed as a distinct `pipeline:<command>` host entry

The host packaging SHALL expose each in-scope pipeline operation as its own
discoverable `pipeline:<command>` command entry, rather than as a flag on a single
`/pipeline` command. The in-scope operation set SHALL be exactly: `status`,
`unblock`, `override`, `summary`, `doctor`, `init`, `cleanup`, `intake`, `sweep`,
`triage`, `merge`, `release`, `roadmap`, `logs`. On the Claude host these entries
SHALL be invocable as `/pipeline:<command>`; on the Codex host they SHALL be
invocable as `$pipeline:<command>`. Each entry SHALL appear in that host's
command/skill discovery surface.

#### Scenario: Every in-scope operation has a host command entry

- **WHEN** the host command surface generated for Claude is enumerated
- **THEN** it SHALL contain a `pipeline:status`, `pipeline:unblock`,
  `pipeline:override`, `pipeline:summary`, `pipeline:doctor`, `pipeline:init`,
  `pipeline:cleanup`, `pipeline:intake`, `pipeline:sweep`, `pipeline:triage`,
  `pipeline:merge`, `pipeline:release`, `pipeline:roadmap`, and `pipeline:logs`
  entry
- **AND** no in-scope operation SHALL be reachable only as a flag on the base
  `/pipeline` command

#### Scenario: A migrated operation is discoverable in the menu

- **WHEN** a developer opens the Claude Code skill/command menu
- **THEN** `pipeline:status` (and each other in-scope entry) SHALL be listed as a
  named command with its own description, without the developer needing to know
  any flag syntax

---

### Requirement: The host command set SHALL be symmetric across Claude and Codex

The `pipeline:<command>` entries SHALL be generated from a single source so that
the Claude host (`/pipeline:<command>`) and the Codex host (`$pipeline:<command>`)
expose the identical operation set with identical argument contracts and identical
target behavior. Neither host SHALL carry an in-scope entry the other lacks.

#### Scenario: Codex exposes the same set as Claude

- **WHEN** the host command surfaces for Claude and Codex are compared
- **THEN** the set of in-scope operation names SHALL be identical on both hosts
- **AND** `$pipeline:triage` (Codex) SHALL perform the same operation with the
  same arguments as `/pipeline:triage` (Claude)

#### Scenario: Adding an operation updates both hosts from one source

- **WHEN** a new in-scope operation is added to the single source list and
  `scripts/build.mjs` is run
- **THEN** both the Claude `commands/` surface and the Codex overlay SHALL gain
  the corresponding entry, and the `plugin/` mirror SHALL regenerate to match

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

---

### Requirement: The advance loop SHALL remain the default invocation, unchanged

The advance loop SHALL remain the default, no-sub-command invocation. `/pipeline N`
(Claude) and `$pipeline N` (Codex) — an issue or PR number with no sub-command —
SHALL continue to invoke the advance loop with identical behavior to before this
change. Promoting operations to `pipeline:<command>` entries SHALL NOT alter, gate,
or rename the no-sub-command advance invocation.

#### Scenario: Numeric invocation still advances

- **WHEN** `/pipeline 42` is invoked with no sub-command
- **THEN** the advance loop SHALL run for issue 42 exactly as it did before this
  change, with no new prefix, keyword, or flag required

---

### Requirement: Behavior-tuning modifier flags SHALL NOT be promoted to `:command` entries

Behavior-tuning modifier flags SHALL NOT be promoted to `pipeline:<flag>` entries.
The flags that tune behavior *within* a command — including `--dry-run`, `--once`,
`--domain`, `--base`, `--repo-path`, `--model`, `--json`, `--detach`,
`--timeout`, `--apply`, `--follow`, `--stage`, `--release`, `--description`,
`--next`, and `--repo` — SHALL remain `--` flags scoped to their command. The
`--doctor` preflight-gate flag (run preflight, then advance, abort on failure)
SHALL likewise be retained as a modifier and SHALL NOT be deprecated or removed by
this change.

#### Scenario: A modifier is not a standalone command

- **WHEN** the host command surface is enumerated
- **THEN** there SHALL be no `pipeline:dry-run`, `pipeline:once`,
  `pipeline:domain`, `pipeline:detach`, `pipeline:json`, or `pipeline:apply` entry
- **AND** `--dry-run`, `--once`, `--detach`, and the other modifiers SHALL still
  be accepted as flags within their respective commands

#### Scenario: The preflight-gate flag is preserved

- **WHEN** `/pipeline 42 --doctor` is invoked
- **THEN** the preflight checks SHALL run and, on success, the advance loop SHALL
  proceed for issue 42 (the gate-then-advance behavior), and `--doctor` SHALL NOT
  emit a deprecation notice

---

### Requirement: The migrated documentation SHALL reflect the new invocation shapes

The README and both hosts' SKILL.md mode/usage tables SHALL document each
operation in its `pipeline:<command>` / `$pipeline:<command>` form and SHALL mark
the legacy mode-selecting flag forms as deprecated. No in-scope operation SHALL be
documented solely in its legacy `--flag` form.

#### Scenario: Docs present the namespaced form

- **WHEN** the README and the Claude/Codex SKILL.md mode tables are inspected
- **THEN** each in-scope operation SHALL be shown as `/pipeline:<command>` /
  `$pipeline:<command>`
- **AND** the legacy flag forms (`--status`, `--summary`, `--unblock`,
  `--override`, `--init`, `--cleanup`) SHALL be annotated as deprecated
