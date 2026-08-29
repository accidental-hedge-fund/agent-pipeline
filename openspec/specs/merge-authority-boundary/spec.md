# merge-authority-boundary Specification

## Purpose

Defines the product boundary between autonomous advance (stop at ready-to-deploy)
and loop-isolated operator-authorized merge surfaces. The repository does not ship
a Hermes/Buzz factory control plane; external supervisors may invoke explicit
Pipeline coordinator commands under bounded operator authority.

## Requirements

### Requirement: Public product positioning SHALL state autonomous-through-ready-to-deploy with operator-owned merge

Operator-facing product docs (at minimum the repository `README.md` front-door summary and the host skill entry summaries under `hosts/*/SKILL.md`) SHALL describe Agent Pipeline as autonomous from issue intake through a green, current, mergeable `pipeline:ready-to-deploy` result. They SHALL state that ordinary merging requires explicit session-bound operator authority via loop-isolated commands. They MAY document that external supervisors can compose those commands. They SHALL NOT document a shipped Hermes/Buzz grant factory control plane as a product requirement. They SHALL NOT imply that the ordinary advance path merges or deploys, or that repository configuration can enable unattended merge.

#### Scenario: README front door names the default boundary

- **WHEN** a reader opens the repository `README.md` product summary
- **THEN** it SHALL state that the ordinary advance path ends at ready-to-deploy and does not merge
- **AND** it SHALL NOT claim there is no operator merge capability while documenting `pipeline merge` or `merge-queue --apply`

#### Scenario: README distinguishes supervisors from a shipped factory plane

- **WHEN** the README describes an external supervisor
- **THEN** it SHALL state that supervisors compose the existing Pipeline CLI
- **AND** it SHALL state that the repository does not ship a Hermes/Buzz factory
  control plane or repository-configured grant schema
- **AND** it SHALL NOT present supervisor composition as an `auto_merge` setting or ordinary advance behavior

#### Scenario: Host skills do not over-claim advance autonomy

- **WHEN** `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` entry descriptions and policy sections are read
- **THEN** they SHALL keep merge and deployment out of the advance loop
- **AND** merge commands SHALL remain separate operator-authorized surfaces

### Requirement: Golden-rule conventions SHALL state no-autonomous-merge with operator carve-out

CLAUDE.md golden rule 4 and the AGENTS.md twin SHALL state that the advance loop stops at `pipeline:ready-to-deploy` and never merges. Merging happens only through loop-isolated commands: direct operator invocation (`pipeline merge` per pull request; `merge-queue --apply` batch with dry-run default; `pipeline train --merge`), or the explicit `pipeline ship --milestone` coordinator that composes those surfaces. The repository SHALL NOT ship a Hermes/Buzz factory control plane, durable grant journal, or repository-configured grant schema as product. No `auto_merge` config key or merge stage SHALL be added. Merge authority is not repository configuration. A signed grant JSON SHALL NOT be required to run `pipeline ship --milestone`.

#### Scenario: CLAUDE.md and AGENTS.md agree

- **WHEN** CLAUDE.md golden rule 4 and AGENTS.md golden rule 4 are compared
- **THEN** both SHALL express advance-loop isolation and the same loop-isolated merge surfaces
- **AND** neither SHALL imply that `pipeline advance` can merge

#### Scenario: Golden rule forbids auto_merge config

- **WHEN** the golden-rule text is read
- **THEN** it SHALL forbid an `auto_merge` config key and a merge stage
- **AND** it SHALL state that merge authority is not repository configuration

#### Scenario: Golden rule names milestone ship without a grant document

- **WHEN** the golden-rule merge carve-out is read
- **THEN** it SHALL name `pipeline ship --milestone` as a loop-isolated operator surface
- **AND** it SHALL NOT require a signed authorization file for that surface

### Requirement: Operator skill copy SHALL name merge and merge-queue --apply as explicit, non-advance surfaces

Host skill documentation that lists merge-related commands SHALL present `pipeline merge`, `pipeline merge-queue` with `--apply`, `pipeline train --merge`, and `pipeline ship --milestone` as explicit authority surfaces that are never called by the advance loop. Merge-queue documentation SHALL keep dry-run as the default. If a host skill mentions external supervisors, it SHALL state that supervisors invoke those Pipeline-owned surfaces and that the repository does not ship a factory control plane. Skills SHALL map phrase `Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z`.

#### Scenario: Skill lists explicit operator merge surfaces

- **WHEN** the host skill command list and policy text are inspected
- **THEN** they SHALL name per-PR merge, merge-queue apply, train merge, and milestone ship as
  explicit non-advance surfaces
- **AND** they SHALL state that the advance loop never invokes them

#### Scenario: Supervisors do not invent a second merge path

- **WHEN** a host skill describes an external supervisor invoking a Pipeline
  merge or ship surface
- **THEN** it SHALL preserve every existing `pipeline merge` gate
- **AND** it SHALL NOT invent a merge path outside the loop-isolated CLI surface

#### Scenario: Dry-run default remains explicit

- **WHEN** merge-queue is described without `--apply`
- **THEN** docs SHALL state that the default is dry-run or plan-only with no merges

#### Scenario: Ship phrase maps to the milestone CLI

- **WHEN** a host skill documents the ship phrase
- **THEN** it SHALL map `Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z`
- **AND** it SHALL NOT require `--authorization` on that argv

### Requirement: Advance-loop isolation of mergePr SHALL remain drift-guarded
The test suite SHALL continue to enforce that `mergePr` (and merge-queue plan/drive entry points used for real merges) are unreachable from the advance loop dispatch path and from autonomous stage handlers. A regression in that isolation SHALL fail CI. Tests MAY exclude the dedicated merge and merge-queue CLI modules themselves from the "stage handler must not import merge" scan when those modules are human-gated CLI surfaces rather than advance stages.

#### Scenario: Isolation tests fail if advance gains mergePr
- **WHEN** the advance dispatch function body is changed to call `mergePr`
- **THEN** the loop-isolation unit test SHALL fail

#### Scenario: Stage handlers stay merge-import free
- **WHEN** an advance-path stage handler file imports the merge module for the purpose of merging during a stage transition
- **THEN** the loop-isolation unit test SHALL fail
- **AND** the human-gated `merge.ts` / `merge-queue.ts` modules themselves MAY remain excluded from that import scan

### Requirement: Integrated train merge mode SHALL be a loop-isolated operator surface

Operator-facing product docs and golden-rule conventions SHALL name `pipeline train --merge` as an explicit, loop-isolated merge orchestration surface in the same class as `pipeline merge` and `pipeline merge-queue --apply`. Invoking train merge mode SHALL NOT make merge reachable from `pipeline advance` stage dispatch. Repository configuration SHALL NOT enable train merge mode via an `auto_merge` key or equivalent.

#### Scenario: Docs list train merge with other non-advance merge surfaces

- **WHEN** README and host skill policy text describe merge surfaces
- **THEN** they SHALL include `pipeline train --merge` as opt-in and explicit
- **AND** they SHALL state that default advance and default loop still stop at ready-to-deploy

#### Scenario: Golden rule forbids auto_merge and still allows train

- **WHEN** CLAUDE.md and AGENTS.md golden-rule merge text is read
- **THEN** they SHALL forbid an `auto_merge` config key and a merge stage
- **AND** they SHALL allow loop-isolated `pipeline train --merge` as an operator-invoked surface

#### Scenario: Advance isolation tests still pass

- **WHEN** the isolation test suite scans advance dispatch and stage handlers
- **THEN** those paths SHALL remain free of merge mutations
- **AND** the train command module MAY call the merge surface without failing the advance isolation scan

### Requirement: Train merge dry-run SHALL NOT merge

`pipeline train --merge --dry-run` SHALL remain inside the loop-isolated train command and SHALL NOT invoke the merge surface, `gh pr merge`, or merge-queue apply. Merge authority for train SHALL still require a live operator-authorized `pipeline train --merge` without `--dry-run` (or `pipeline ship --milestone`, which composes live train merge). A dry-run plan SHALL NOT be treated as merge authorization.

#### Scenario: Merge-mode dry-run performs no merge

- **WHEN** an operator runs `pipeline train --milestone v1.39.13 --merge --dry-run`
- **THEN** the command SHALL print a plan
- **AND** it SHALL NOT merge any pull request

#### Scenario: Live train merge remains the authority surface

- **WHEN** an operator runs `pipeline train --milestone v1.39.13 --merge` without `--dry-run`
- **THEN** existing train merge-mode law SHALL apply
- **AND** dry-run SHALL NOT be implied
