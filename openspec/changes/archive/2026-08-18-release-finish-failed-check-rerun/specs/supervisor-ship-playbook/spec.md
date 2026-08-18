## ADDED Requirements

### Requirement: Ship playbook C0 wait SHALL adopt the shared ship-release check-wait recipe

The chain-to-existing-tools ship playbook SHALL apply the shared `ship-release-check-wait` classifier and bounded rerun recipe during the C0 wait before `pipeline release finish`. The playbook SHALL poll with a valid `gh pr checks --json` field set that includes `bucket` and `link` and SHALL NOT request a non-existent `conclusion` field. On classification `rerun`, the playbook SHALL request `gh run rerun --failed` and resume the existing wait loop. On classification `fail`, the playbook SHALL mark release-finish failed and SHALL NOT invoke `pipeline release finish`. The playbook SHALL NOT keep a divergent “any settled fail is immediately terminal” policy.

#### Scenario: Playbook first test fail reruns then waits

- **WHEN** the playbook’s wait helper classifies the release PR checks as `rerun`
- **AND** rerun budget remains
- **THEN** the playbook SHALL request `gh run rerun --failed`
- **AND** it SHALL continue waiting
- **AND** it SHALL NOT write release-finish `failed` on that poll

#### Scenario: Playbook terminal fail does not call finish

- **WHEN** the shared wait helper reports `fail`
- **THEN** the playbook SHALL mark the release-finish phase failed
- **AND** it SHALL NOT invoke `pipeline release finish`

#### Scenario: Playbook green after rerun calls finish

- **WHEN** the playbook has requested one rerun for a `test` fail
- **AND** a later poll reports checks green
- **THEN** the playbook SHALL invoke `pipeline release finish` for that same PR

### Requirement: Ship playbook release-finish fail detail SHALL prefer the checks sidecar over leftover train warns

When the playbook marks release-finish failed because the shared waiter classified `fail`, the playbook SHALL enrich state and notify from the checks-fail sidecar (PR, check name, bucket or state, run URL, last failed test title when present). The lead reason SHALL NOT be a leftover `[pipeline] tester-evidence:` line or a `trusted-surface blocked` warn from an earlier train item.

#### Scenario: Playbook STOP names the check URL

- **WHEN** the playbook STOPs release-finish after a terminal `test` fail
- **AND** the checks sidecar includes an Actions run URL
- **THEN** the failed state/notify detail SHALL include that check name and run URL
- **AND** it SHALL NOT lead with `tester-evidence` or `trusted-surface blocked`
