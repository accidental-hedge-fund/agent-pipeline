# namespaced-command-surface Specification

## Purpose
TBD - created by archiving change namespaced-command-surface. Update Purpose after archive.
## Requirements
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

### Requirement: The `loop` operation SHALL use long-running packaging, not the shared fast template

Host SKILL guidance for multi-item drive and resume of `pipeline loop` SHALL treat the
operation as long-running. Host skill guidance for drive and resume SHALL NOT claim
that the command “completes in seconds” and SHALL NOT instruct harnesses that “no
background process or Monitor is needed.” Read-only `--audit` MAY remain documented
as a short synchronous mode. This requirement SHALL NOT depend on a generated
`pipeline:loop.md` command file.

#### Scenario: Loop is not rendered with the fast template

- **WHEN** the Claude or Codex host SKILL describes `pipeline loop` drive or resume
- **THEN** that guidance SHALL NOT contain the substring “completes in seconds”
  (case-insensitive)
- **AND** SHALL NOT contain the substring “No background process or Monitor needed”
  (case-insensitive)
- **AND** `scripts/build.mjs` SHALL NOT write `plugin/pipeline/commands/pipeline:loop.md`

#### Scenario: True-fast peers still use the fast template

- **WHEN** host SKILL or CLI docs describe a true-fast operation such as `status` or `doctor`
- **THEN** they MAY still note that those CLI verbs complete in seconds
- **AND** the generator SHALL NOT emit a `pipeline:status.md` or `pipeline:doctor.md` command file to carry that note

#### Scenario: Audit mode stays synchronous

- **WHEN** host or CLI docs describe `pipeline loop --audit`
- **THEN** they MAY document that mode as read-only and seconds-long
- **AND** they SHALL NOT use that audit guidance as the orchestration rule for
  drive or resume

### Requirement: The merge-queue host entry SHALL document dry-run default and human authority

The `pipeline merge-queue` CLI and host SKILL description SHALL state that the command
plans an ordered ready-to-deploy merge queue under explicit operator invocation,
defaults to dry-run, and is never called by the advance loop. It SHALL NOT
describe autonomous or background merging. This requirement SHALL NOT depend on a
generated `pipeline:merge-queue.md` command file.

#### Scenario: Host one-liner states dry-run and non-advance

- **WHEN** the CLI or host SKILL description for `pipeline merge-queue` is inspected
- **THEN** it SHALL mention dry-run (or default non-mutating plan) behavior
- **AND** SHALL NOT claim the advance loop merges via this command

### Requirement: Host recover-parked entry SHALL only forward to the CLI

Host SKILL packaging for recover-parked SHALL document invocation of the engine CLI
`pipeline recover-parked` (and any Tugboat/Hermes skill text that documents the
operation), or no-op + STOP when the host chooses not to invoke it. Host packaging
and skill prose SHALL NOT instruct inventing `pipeline override` dispositions,
dropping `blocked`/`needs-human` labels, or reclassifying structured
HIGH/CRITICAL/security findings outside the CLI. This requirement SHALL NOT depend
on a generated `pipeline:recover-parked.md` command file.

#### Scenario: Host entry documents CLI-only reflow

- **WHEN** an operator reads the host SKILL recover-parked guidance
- **THEN** the documented action SHALL be invocation of `pipeline recover-parked`
- **AND** it SHALL NOT document a host-local override or label-drop alternative for the same reflow

#### Scenario: Host skill must not invent override for parked residuals

- **WHEN** a thin host observes `needs-human` or leftover `blocked` after deterministic resume
- **THEN** the host contract SHALL allow calling `pipeline recover-parked` once or STOP
- **AND** SHALL forbid host-improvised `pipeline override` or silent removal of `blocked` for that reflow

### Requirement: Hosts SHALL invoke CLI verbs rather than a generated command pack

Claude, Codex, and Grok SHALL expose in-scope operations by exec of `pipeline <verb>` from the host SKILL. The in-scope operation set SHALL remain the CLI keywords (including `status`, `unblock`, `override`, `summary`, `doctor`, `init`, `cleanup`, `intake`, `sweep`, `triage`, `merge`, `merge-queue`, `release`, `roadmap`, `logs`, `loop`, `recover-parked`). Hosts SHALL NOT require a generated `pipeline:<command>` file per verb. Adding a verb to `OPERATION_SURFACE` SHALL update the catalog. It SHALL NOT emit a host command file.

#### Scenario: Status is a CLI verb not a slash file

- **WHEN** an operator wants issue 42 status
- **THEN** the product invocation SHALL be `pipeline status 42`
- **AND** a `pipeline:status.md` host command file SHALL NOT be required

#### Scenario: Catalog change does not emit command files

- **WHEN** a verb is present in `OPERATION_SURFACE` and `scripts/build.mjs` is run
- **THEN** the generator SHALL NOT write `pipeline:<verb>.md` or Codex `pipeline-<verb>.yaml` command agents
