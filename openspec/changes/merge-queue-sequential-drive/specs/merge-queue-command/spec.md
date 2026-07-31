## MODIFIED Requirements

### Requirement: Merge-queue dry-run SHALL be the default and SHALL perform zero mutations
The merge-queue command SHALL default to dry-run mode. In dry-run mode the
handler SHALL inspect GitHub state and print a plan only. It SHALL NOT invoke
`gh pr merge`, push, force-push, delete a branch, add/remove labels, close
issues, create comments, or otherwise mutate repository or issue state. An
explicit `--dry-run` flag SHALL be accepted as affirming the default.

When the operator passes explicit `--apply` (or the documented confirm flag),
the command SHALL enter merge-queue **drive** mode (see `merge-queue-drive`):
plan the ordered candidate set, then walk it sequentially through the existing
`mergePr` surface. Drive SHALL NOT activate without that explicit flag. There
is no `auto_merge` config key that enables drive.

Combining `--apply` with `--dry-run` SHALL exit non-zero with a usage error and
perform zero merges.

#### Scenario: Default invocation is dry-run with no merges
- **WHEN** the user runs `pipeline merge-queue --milestone "v1.28.2"`
- **THEN** the handler SHALL run in dry-run mode
- **AND** SHALL NOT call any merge primitive or mutating GitHub write

#### Scenario: Explicit --dry-run is accepted
- **WHEN** the user runs `pipeline merge-queue --milestone "v1.28.2" --dry-run`
- **THEN** the handler SHALL produce the same class of plan output as the default
- **AND** SHALL NOT mutate GitHub state

#### Scenario: Explicit --apply enters drive
- **WHEN** the user runs `pipeline merge-queue --milestone "v1.28.2" --apply`
- **THEN** the handler MAY call `mergePr` for eligible candidates per `merge-queue-drive`
- **AND** the operator invoking `--apply` is the merge authority for that process session only

#### Scenario: --apply with --dry-run is rejected
- **WHEN** the user passes both `--apply` and `--dry-run`
- **THEN** the command SHALL exit non-zero with a usage error
- **AND** SHALL NOT merge any PR

#### Scenario: Dry-run is idempotent
- **WHEN** the user runs the same dry-run invocation twice against unchanged
  GitHub state
- **THEN** both runs SHALL report the same ordered merge-candidate set and the
  same skip set (same issue/PR identities and order)
- **AND** neither run SHALL mutate GitHub state
