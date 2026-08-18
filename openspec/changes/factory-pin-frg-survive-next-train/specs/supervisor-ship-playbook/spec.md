## ADDED Requirements

### Requirement: Installed skip-frg ship composer SHALL fail doctor preflight

When an installed Tugboat or chain-to-existing-tools ship playbook is present at a
documented install path (`~/.local/bin/tugboat`, `~/.local/bin/pipeline-ship-playbook`,
or equivalent) and its default release or promote argv still hard-codes `--skip-frg`
(the pre-#1039 skip-frg playbook), doctor preflight SHALL fail closed. Remediation
SHALL require refreshing the composer from the repo example (or invoking the versioned
repo path). Absence of an installed composer SHALL skip the check. When the operator
escape is active for that doctor process (`--skip-frg` / documented env with a logged
reason), the check SHALL NOT fail solely for the escape path existing in the source.

A unit or doctor test SHALL fail if the installed-composer evaluator accepts a body
whose default release or promote argv still contains `--skip-frg`.

#### Scenario: Installed playbook with hard-coded skip-frg fails doctor

- **WHEN** doctor runs and `~/.local/bin/pipeline-ship-playbook` exists
- **AND** that file's default release or promote argv hard-codes `--skip-frg`
- **AND** no operator skip escape is active in the doctor environment
- **THEN** the skip-frg composer check SHALL fail
- **AND** remediation SHALL name refresh from the repo example

#### Scenario: Installed Tugboat with hard-coded skip-frg fails doctor

- **WHEN** doctor runs and an installed Tugboat exists at the documented path
- **AND** that file's default release or promote argv hard-codes `--skip-frg`
- **THEN** the skip-frg composer check SHALL fail
- **AND** remediation SHALL name refresh from `examples/supervisor/shell/tugboat.sh`

#### Scenario: Missing installed composer skips the check

- **WHEN** doctor runs and no installed Tugboat or ship playbook is present
- **THEN** the skip-frg composer check SHALL skip
- **AND** doctor SHALL NOT fail solely because the host does not use thin ship

#### Scenario: Fixture regression fails the old skip-frg playbook

- **WHEN** unit tests evaluate a fixture composer body whose default release or
  promote argv contains `--skip-frg`
- **THEN** the evaluation SHALL report fail
- **AND** the same evaluation SHALL report pass for a body whose default argv omits
  `--skip-frg` and retains a logged-reason escape
