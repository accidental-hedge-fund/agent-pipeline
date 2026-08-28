## ADDED Requirements

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
