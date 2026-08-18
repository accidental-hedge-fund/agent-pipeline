## ADDED Requirements

### Requirement: Tugboat release-finish wait SHALL adopt the shared ship-release check-wait recipe

Tugboat SHALL apply the shared `ship-release-check-wait` classifier and bounded rerun recipe during the CI wait before `pipeline release finish`. Tugboat SHALL NOT implement a second divergent classify or rerun policy in the composer body. On classification `rerun`, Tugboat SHALL request `gh run rerun --failed` and resume the existing wait loop. On classification `fail`, Tugboat SHALL mark the release-finish phase failed and SHALL NOT invoke `pipeline release finish`.

#### Scenario: First flake-eligible test fail does not STOP Tugboat

- **WHEN** Tugboat’s wait helper classifies the release PR checks as `rerun`
- **AND** rerun budget remains
- **THEN** Tugboat SHALL request `gh run rerun --failed` for the failed run id
- **AND** it SHALL continue the wait loop
- **AND** it SHALL NOT write release-finish `failed` on that poll

#### Scenario: Shared helper is the only classify path

- **WHEN** an automated check inspects Tugboat’s release-finish wait
- **THEN** Tugboat SHALL invoke the shared wait helper for the checks capture
- **AND** it SHALL NOT treat a raw helper `-1` as immediate `exit 1` when the shared recipe still classifies `rerun`

### Requirement: Tugboat release-finish fail detail SHALL prefer the checks sidecar over leftover train warns

When Tugboat marks release-finish failed because the shared waiter classified `fail`, Tugboat SHALL enrich state and notify from the checks-fail sidecar (PR, check name, bucket or state, run URL, last failed test title when present). The lead reason SHALL NOT be a leftover `[pipeline] tester-evidence:` line or a `trusted-surface blocked` warn from an earlier train item.

#### Scenario: Release-finish STOP names the check URL

- **WHEN** Tugboat STOPs release-finish after a terminal `test` fail
- **AND** the checks sidecar includes an Actions run URL
- **THEN** the failed state/notify detail SHALL include that check name and run URL
- **AND** it SHALL NOT lead with `tester-evidence` or `trusted-surface blocked`

## MODIFIED Requirements

### Requirement: Tugboat SHALL wait for green release PR checks before release finish

Before calling `pipeline release finish`, Tugboat SHALL poll the release PR checks using a valid `gh pr checks --json` field set that includes `bucket` and `link` and SHALL NOT rely on a non-existent `conclusion` field. Tugboat SHALL call release finish only after the shared wait helper reports checks green. Tugboat SHALL apply the shared `ship-release-check-wait` recipe on a settled fail: a flake-eligible `test` (or documented equivalent) fail SHALL request a bounded `gh run rerun --failed` and resume wait; Tugboat SHALL fail closed only after that budget is spent or the fail includes a non-test product check. Tugboat SHALL also fail closed if the wait-attempt budget is exhausted while checks are still not green.

#### Scenario: Finish is not called while checks are pending

- **WHEN** the release PR checks are still pending within the wait budget
- **THEN** Tugboat SHALL continue waiting
- **AND** it SHALL NOT invoke `pipeline release finish` for that PR until the green helper reports green

#### Scenario: Failed checks fail closed before finish

- **WHEN** the shared wait helper reports that release PR checks are a terminal `fail`
- **THEN** Tugboat SHALL mark the release-finish phase failed
- **AND** it SHALL NOT invoke `pipeline release finish`

#### Scenario: First flake-eligible fail reruns then waits

- **WHEN** the shared wait helper reports `rerun` for a settled `test` fail
- **AND** rerun budget remains
- **THEN** Tugboat SHALL request `gh run rerun --failed`
- **AND** it SHALL continue waiting
- **AND** it SHALL NOT mark release-finish failed on that poll

#### Scenario: Green after rerun calls finish

- **WHEN** Tugboat has requested one rerun for a `test` fail
- **AND** a later poll reports checks green
- **THEN** Tugboat SHALL invoke `pipeline release finish` for that same PR
