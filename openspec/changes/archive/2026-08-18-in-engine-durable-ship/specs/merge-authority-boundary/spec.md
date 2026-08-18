## MODIFIED Requirements

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

Host skill documentation that lists merge-related commands SHALL present `pipeline merge` (or `/pipeline:merge`), `pipeline merge-queue` with `--apply`, `pipeline train --merge`, and `pipeline ship --milestone` as explicit authority surfaces that are never called by the advance loop. Merge-queue documentation SHALL keep dry-run as the default. If a host skill mentions external supervisors, it SHALL state that supervisors invoke those Pipeline-owned surfaces and that the repository does not ship a factory control plane. Skills SHALL map phrase `Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z`.

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
