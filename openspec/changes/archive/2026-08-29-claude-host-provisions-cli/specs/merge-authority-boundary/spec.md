## MODIFIED Requirements

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
