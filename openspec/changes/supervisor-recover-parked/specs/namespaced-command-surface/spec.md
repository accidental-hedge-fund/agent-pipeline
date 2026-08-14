## MODIFIED Requirements

### Requirement: Each in-scope operation SHALL be exposed as a distinct `pipeline:<command>` host entry

The host packaging SHALL expose each in-scope pipeline operation as its own
discoverable `pipeline:<command>` command entry, rather than as a flag on a single
`/pipeline` command. The in-scope operation set SHALL be exactly: `status`,
`unblock`, `override`, `summary`, `doctor`, `init`, `cleanup`, `intake`, `sweep`,
`triage`, `merge`, `merge-queue`, `release`, `roadmap`, `logs`, `loop`,
`recover-parked`. On the
Claude host these entries SHALL be invocable as `/pipeline:<command>`; on the
Codex host they SHALL be invocable as `$pipeline:<command>`. Each entry SHALL
appear in that host's command/skill discovery surface.

#### Scenario: Every in-scope operation has a host command entry

- **WHEN** the host command surface generated for Claude is enumerated
- **THEN** it SHALL contain a `pipeline:status`, `pipeline:unblock`,
  `pipeline:override`, `pipeline:summary`, `pipeline:doctor`, `pipeline:init`,
  `pipeline:cleanup`, `pipeline:intake`, `pipeline:sweep`, `pipeline:triage`,
  `pipeline:merge`, `pipeline:merge-queue`, `pipeline:release`, `pipeline:roadmap`,
  `pipeline:logs`, `pipeline:loop`, and `pipeline:recover-parked` entry
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

#### Scenario: recover-parked host entry is generated from the same single source

- **WHEN** `recover-parked` is present in the single-source operation list and
  `scripts/build.mjs` is run
- **THEN** the Claude `commands/` surface SHALL gain `pipeline:recover-parked` (or
  equivalent host entry) and the Codex overlay SHALL gain the matching agent entry
- **AND** the `plugin/` mirror SHALL regenerate to match when host packaging is mirrored

## ADDED Requirements

### Requirement: Host recover-parked entry SHALL only forward to the CLI

The host `pipeline:recover-parked` entry (Claude `/pipeline:recover-parked`, Codex
`$pipeline:recover-parked`, and any Tugboat/Hermes skill text that documents the
operation) SHALL forward exclusively to the engine CLI `pipeline recover-parked`
(or no-op + STOP when the host chooses not to invoke it). Host packaging and skill
prose SHALL NOT instruct inventing `pipeline override` dispositions, dropping
`blocked`/`needs-human` labels, or reclassifying structured HIGH/CRITICAL/security
findings outside the CLI.

#### Scenario: Host entry documents CLI-only reflow

- **WHEN** an operator reads the host `pipeline:recover-parked` command or skill entry
- **THEN** the documented action SHALL be invocation of `pipeline recover-parked`
- **AND** it SHALL NOT document a host-local override or label-drop alternative for the same reflow

#### Scenario: Host skill must not invent override for parked residuals

- **WHEN** a thin host observes `needs-human` or leftover `blocked` after deterministic resume
- **THEN** the host contract SHALL allow calling `pipeline recover-parked` once or STOP
- **AND** SHALL forbid host-improvised `pipeline override` or silent removal of `blocked` for that reflow
