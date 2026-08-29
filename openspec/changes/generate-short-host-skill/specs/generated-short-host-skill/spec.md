## Purpose

Generate one short host SKILL per in-repo SKILL host from `OPERATION_SURFACE` and one shared follow/notify contract, and delete the handwritten 80KB host essays.

## ADDED Requirements

### Requirement: Repository SHALL keep one shared orchestration-contract source

The repository SHALL keep one committed shared orchestration-contract source (a module, a doc, or both treated as one source) that is not a per-host essay. That source SHALL state the follow/notify contract: capture `run_id` from the durable handoff, follow `pipeline loop logs --events --follow` or the equivalent `pipeline logs <run-id> --events --follow` path, stop follow on a terminal run event, and forbid the follower or observer from invoking a merge-capable command. Issue #971 SHALL be able to consume that same source without copying a host SKILL essay. This change SHALL NOT add Hermes or OpenClaw install logic.

#### Scenario: Shared contract names follow-until-terminal

- **WHEN** a reader opens the shared orchestration-contract source
- **THEN** the source SHALL name `run_id`
- **AND** it SHALL name `pipeline loop logs --events --follow` or the equivalent logs follow
- **AND** it SHALL require stop on a terminal run event

#### Scenario: Shared contract forbids follower merge

- **WHEN** a reader opens the shared orchestration-contract source
- **THEN** the source SHALL state that the follower or observer never invokes a merge-capable command
- **AND** it SHALL name at least `merge`, `merge-queue --apply`, `train --merge`, and `ship` as merge-capable

#### Scenario: Supervisor pack can reuse the source

- **WHEN** issue #971 needs a host-neutral one-pager
- **THEN** it SHALL be able to import or render the same committed source
- **AND** this change SHALL NOT add Hermes or OpenClaw install paths

---

### Requirement: Generator SHALL emit four short host SKILLs from the shared source

A deterministic generator SHALL write `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md` from `OPERATION_SURFACE` plus the shared orchestration-contract source. The four files SHALL differ only by host invocation token and host notify-tool names. They SHALL NOT encode host-specific stage-machine logic. The generator SHALL NOT write `/pipeline:*` markdown command files or Codex `$pipeline:*` yaml agents.

#### Scenario: Four generated SKILLs exist

- **WHEN** the generator runs on a complete tree
- **THEN** it SHALL write `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md`
- **AND** each file SHALL be produced from the shared source plus `OPERATION_SURFACE`

#### Scenario: Hosts share one contract

- **WHEN** the four generated SKILL bodies are compared with invocation tokens and notify-tool names stripped
- **THEN** they SHALL carry the same verb set and the same follow/notify obligations
- **AND** they SHALL NOT contain different stage lists, stage handlers, or stage-order rules per host

#### Scenario: Generator does not emit command packs

- **WHEN** the generator or `scripts/build.mjs` runs
- **THEN** it SHALL NOT write `plugin/pipeline/commands/pipeline:<verb>.md`
- **AND** it SHALL NOT write Codex `pipeline-<verb>.yaml` command agents from `OPERATION_SURFACE`

---

### Requirement: Each generated SKILL SHALL be a one-pager of verb table, follow contract, and doc pointers

Each generated host SKILL SHALL contain an `OPERATION_SURFACE` verb table, the shared follow/notify contract, and working pointers to `docs/packaging.md` and `docs/cli.md`. Each generated SKILL SHALL NOT contain the retired engine-essay sections: state-machine walkthrough, per-repo config dump, evals manifesto, or §4 / §4b / §4c bash discovery scripts. `train` and `ship` SHALL appear in `OPERATION_SURFACE` and in each generated verb table as explicit operator-authorized verbs. The follow contract SHALL NOT escalate into `train` or `ship`.

#### Scenario: SKILL carries the required three parts

- **WHEN** a reader opens any of the four generated SKILLs
- **THEN** the file SHALL contain a verb table sourced from `OPERATION_SURFACE`
- **AND** it SHALL contain the follow/notify contract
- **AND** it SHALL point at `docs/packaging.md` and `docs/cli.md`

#### Scenario: Retired essays are absent

- **WHEN** a reader inspects the four generated SKILLs
- **THEN** they SHALL NOT contain a state-machine walkthrough section
- **AND** they SHALL NOT contain a per-repo config YAML dump
- **AND** they SHALL NOT contain an evals manifesto
- **AND** they SHALL NOT contain §4 / §4b / §4c bash discovery scripts

#### Scenario: Train and ship stay on the operation surface

- **WHEN** `OPERATION_SURFACE` and a generated SKILL verb table are inspected
- **THEN** both SHALL list `train` and `ship`
- **AND** the follow/notify contract SHALL NOT instruct the follower to invoke `train` or `ship`

---

### Requirement: OMP, Tugboat, Eve, and Foreman SHALL NOT receive a generated SKILL

The repository SHALL NOT keep `hosts/omp/SKILL.md`. The generator SHALL NOT emit a SKILL for OMP, Tugboat, Eve, or Foreman. OMP MAY remain an installer host for the CLI tree without a SKILL overlay.

#### Scenario: OMP SKILL is gone

- **WHEN** the change is implemented
- **THEN** `hosts/omp/SKILL.md` SHALL be absent
- **AND** the generator SHALL NOT write that path

#### Scenario: No Eve or Foreman host SKILL

- **WHEN** the host SKILL set is enumerated
- **THEN** there SHALL be no Eve host SKILL
- **AND** there SHALL be no Foreman host SKILL

---

### Requirement: Tests SHALL pin generated SKILL freshness and forbid host-specific stage logic

A co-located unit test SHALL fail when a committed generated host SKILL differs from a fresh generation. A co-located unit test SHALL fail when a generated SKILL encodes host-specific stage-machine logic. A co-located unit test SHALL fail when the generator writes a per-verb slash-command or yaml-agent file. Those tests SHALL perform no network, git, or subprocess calls beyond in-process generation.

#### Scenario: Stale generated SKILL fails

- **WHEN** a committed `hosts/claude/SKILL.md` (or Codex, Grok, or OpenCode peer) differs from a fresh generation
- **THEN** the freshness test SHALL fail

#### Scenario: Host-specific stage logic fails

- **WHEN** one generated SKILL names a stage list or stage handler that another generated SKILL omits or contradicts
- **THEN** the host-parity test SHALL fail

#### Scenario: Command-file generation fails the guard

- **WHEN** the generator would write a `pipeline:<verb>.md` or Codex `pipeline-<verb>.yaml` command file
- **THEN** the command-pack test SHALL fail
