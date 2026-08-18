## Purpose

Defines the shared ship-path waiter for a release pull request’s observable GitHub checks: classify the set, apply a bounded failed-run rerun for flake-eligible test jobs, and emit structured fail detail that names the check and the Actions run URL.

## ADDED Requirements

### Requirement: The ship-release check waiter SHALL classify a checks capture into exactly one of four outcomes

The shared ship-release check waiter SHALL classify a `gh pr checks --json` capture into exactly one of: `green` (safe to call release finish), `pending` (keep waiting), `rerun` (flake-eligible settled fail, rerun still in budget), or `fail` (terminal). Classification SHALL be deterministic from check metadata. Classification SHALL NOT require a non-deterministic LLM. The waiter SHALL request a valid `gh pr checks --json` field set that includes `name`, `state`, `bucket`, and `link`. The waiter SHALL NOT request a non-existent `conclusion` field.

#### Scenario: All passing checks classify as green

- **WHEN** every observable check is in a pass or skip bucket
- **THEN** the waiter SHALL classify the capture as `green`

#### Scenario: Any pending check classifies as pending

- **WHEN** at least one observable check is pending, queued, or in progress
- **THEN** the waiter SHALL classify the capture as `pending`
- **AND** it SHALL NOT classify the capture as `rerun` or `fail` on that poll

#### Scenario: Pending plus fail in one capture is pending

- **WHEN** one check is in a fail bucket
- **AND** another check in the same capture is pending
- **THEN** the waiter SHALL classify the capture as `pending`

### Requirement: A settled fail SHALL be rerun-eligible only when every failed check is flake-eligible

The waiter SHALL treat a settled fail as `rerun` only when every failed check’s `name` is on the flake-eligible allowlist. The default allowlist SHALL include `test`. Documented equivalents SHALL be names of the same unit-test job class (the repository Actions job that runs the unit-test suite). A settled fail that includes any check name outside that allowlist SHALL classify as `fail`. A mixed failed set (flake-eligible plus non-eligible) SHALL classify as `fail`.

#### Scenario: Sole test fail is rerun-eligible

- **WHEN** the only settled failed check is named `test`
- **AND** no other check is pending
- **AND** rerun budget remains
- **THEN** the waiter SHALL classify the capture as `rerun`

#### Scenario: Non-test product fail is terminal

- **WHEN** a settled failed check has a name outside the flake-eligible allowlist (for example a release-file build job)
- **AND** no check is pending
- **THEN** the waiter SHALL classify the capture as `fail`
- **AND** it SHALL NOT request `gh run rerun --failed`

#### Scenario: Mixed test fail and product fail is terminal

- **WHEN** check `test` is failed
- **AND** another non-eligible check is also failed
- **AND** no check is pending
- **THEN** the waiter SHALL classify the capture as `fail`
- **AND** it SHALL NOT request `gh run rerun --failed`

### Requirement: A rerun-eligible fail SHALL request one bounded failed-workflow rerun then resume wait

When the classification is `rerun`, the waiter SHALL extract the workflow run id from the failed check’s `link` (`/actions/runs/<id>`), request `gh run rerun --failed <id>`, record the attempt against the current release-PR head SHA, and resume the existing wait loop. The default budget SHALL be one rerun per head SHA per waiter run. The budget SHALL NOT exceed two. After the budget is spent, a still-red flake-eligible set SHALL classify as `fail`. When no run id can be resolved or the rerun request fails, the waiter SHALL record the attempt as consumed or unavailable and SHALL classify as `fail` rather than loop.

#### Scenario: First test fail reruns once and waits

- **WHEN** the first settled capture is a flake-eligible `test` fail with a workflow run `link`
- **AND** no rerun has been recorded for that head SHA
- **THEN** the waiter SHALL request `gh run rerun --failed` for that run id exactly once
- **AND** it SHALL resume waiting
- **AND** it SHALL NOT mark the release-finish phase failed on that poll

#### Scenario: Green after one rerun proceeds

- **WHEN** the waiter has requested one rerun for a `test` fail
- **AND** a later poll reports `test` as pass
- **THEN** the waiter SHALL classify the capture as `green`
- **AND** the ship composer SHALL be allowed to invoke `pipeline release finish` for that PR

#### Scenario: Second test fail after budget is terminal

- **WHEN** a rerun has already been recorded for the head SHA
- **AND** a later settled capture is still a `test` fail
- **THEN** the waiter SHALL NOT request another `gh run rerun --failed`
- **AND** it SHALL classify the capture as `fail`

#### Scenario: Missing run id fails closed without looping

- **WHEN** the only settled fail is flake-eligible
- **AND** no workflow run id can be extracted from `link`
- **THEN** the waiter SHALL classify the capture as `fail`
- **AND** it SHALL NOT retry the rerun request in a loop

### Requirement: Terminal fail detail SHALL name the check and run URL and SHALL NOT lead with leftover tester-evidence

When the waiter classifies `fail`, the operator-visible detail SHALL include the release PR number, the failed check name, the check bucket or state, and the Actions run URL when `link` is present. When a bounded failed-log excerpt or check description yields a last failed test title, the detail SHALL include that title. The lead reason SHALL come from the checks capture (or a sidecar written from it). The lead reason SHALL NOT be a leftover `[pipeline] tester-evidence:` line or a `trusted-surface blocked` warn from an earlier train item.

#### Scenario: Budget-exhausted test fail names check and run URL

- **WHEN** the waiter STOPs after the rerun budget is spent on check `test`
- **AND** the failed check has `link` `https://github.com/o/r/actions/runs/32075787450`
- **THEN** the operator-visible detail SHALL include the PR number, `test`, a fail/bucket token, and `32075787450` or that run URL
- **AND** the detail SHALL NOT lead with `[pipeline] tester-evidence:`
- **AND** the detail SHALL NOT lead with `trusted-surface blocked`

#### Scenario: Last failed test title is included when available

- **WHEN** the waiter STOPs on a `test` fail
- **AND** a bounded failed-log excerpt contains `✖ detach race (#1062 R2): concurrent Ship detaches exactly once`
- **THEN** the operator-visible detail SHALL include that test title (or an unambiguous prefix of it)

#### Scenario: Leftover train warn is ignored when a checks sidecar exists

- **WHEN** the ship log contains `[pipeline] tester-evidence: trusted-surface blocked prevents readiness subject emission (fail closed)`
- **AND** a checks-fail sidecar names check `test` and a run URL
- **THEN** the release-finish fail detail SHALL prefer the sidecar
- **AND** it SHALL NOT use the tester-evidence line as the lead reason

### Requirement: Re-entry after a later green check SHALL reuse the existing open release PR

When a later poll or a later Ship / `release finish` for the same version observes the same open release PR with green checks, the waiter and composer SHALL continue with that PR number. They SHALL NOT open a second release PR for that version solely because an earlier waiter poll classified `fail` or `rerun`.

#### Scenario: Re-Ship after later green reuses the open PR

- **WHEN** release PR `#1109` is still open for version `X.Y.Z`
- **AND** its checks are later green
- **AND** the operator re-invokes Ship or release finish for `X.Y.Z`
- **THEN** the composer SHALL reuse PR `#1109`
- **AND** it SHALL NOT open a second release PR for `X.Y.Z`
