## Purpose

Classifies git-push failures so a stale local tip versus the PR or remote head is workflow-state, never a transient rate limit, and never reconciled by force-push.

## ADDED Requirements

### Requirement: Shared push classifier SHALL treat non-fast-forward as workflow-state
The shared git-push classifier SHALL classify stderr that contains `non-fast-forward`, `rejected`, or `fetch first` as reason code `workflow-state` with `head_drift: true`. The classifier SHALL apply on every wrapper path, including a fail-closed `siteId` path that does not retry. The classifier SHALL NOT emit `transient-infra` for that stderr. A later caller SHALL NOT remap that classified result to `transient-infra` or durable class `transient-rate-limit`.

#### Scenario: #1038 non-fast-forward fixture is workflow-state
- **WHEN** the shared push classifier receives the #1038 park fixture stderr containing `non-fast-forward` and the behind-remote / `fetch first` hint
- **THEN** it SHALL return `reason_code: "workflow-state"` and `head_drift: true`
- **AND** it SHALL NOT return `reason_code: "transient-infra"`
- **AND** durable projection SHALL yield blocker class `workflow-state`, not `transient-rate-limit`

#### Scenario: Fail-closed site path still classifies non-fast-forward as workflow-state
- **WHEN** the shared push wrapper is invoked with a site that is not eligible for transient retry
- **AND** the single push attempt is rejected with the #1038 non-fast-forward fixture
- **THEN** the wrapper SHALL still return `reason_code: "workflow-state"` and `head_drift: true`
- **AND** it SHALL NOT return blanket `transient-infra` with `head_drift: false`

#### Scenario: True transient push remains transient-infra
- **WHEN** the shared push classifier receives stderr that is an HTTP 5xx, connection reset, or equivalent transient transport blip and does not contain `non-fast-forward`, `rejected`, or `fetch first`
- **THEN** it SHALL classify that failure as `transient-infra`
- **AND** a `transient-retryable` site MAY retry that failure under the existing currency-check wrapper

### Requirement: A blocked push SHALL carry the wrapper classified reason
A stage that blocks after a shared-wrapper push failure SHALL emit the stage diagnostic with the wrapper’s classified `reason_code`. The stage SHALL NOT replace that code with a site-default such as `head_drift ? workflow-state : transient-infra` that would turn a non-fast-forward into `transient-infra`.

#### Scenario: Fix-stage push-failed diagnostic uses wrapper reason
- **WHEN** the fix stage blocks with `blockerKind: "push-failed"` after the shared wrapper returns the #1038 non-fast-forward classification
- **THEN** the emitted stage diagnostic `reason_code` SHALL be `workflow-state`
- **AND** the durable loop recipe selected for that diagnostic SHALL NOT be `wait_and_retry`

#### Scenario: Planning-stage push-failed diagnostic uses wrapper reason
- **WHEN** the planning stage blocks with `blockerKind: "push-failed"` after the shared wrapper returns a classified failure
- **THEN** the emitted stage diagnostic `reason_code` SHALL be the wrapper `reason_code`
- **AND** the stage SHALL NOT omit the diagnostic or replace it with a site-default `transient-infra`

### Requirement: The engine SHALL never force-push to reconcile a non-fast-forward
The engine SHALL NOT issue `git push --force` or `git push --force-with-lease` to make a stale or diverged local tip overwrite the PR or remote head. A non-fast-forward result SHALL recover by rematerialize or fast-forward of the managed worktree to that remote head, or by skipping a redundant ancestor push, never by rewriting the remote tip.

#### Scenario: Non-fast-forward never retries with force
- **WHEN** a push to `origin/<branch>` is rejected non-fast-forward
- **THEN** no subsequent recovery or retry step SHALL invoke `git push --force` or `--force-with-lease`
- **AND** the remote PR head SHALL remain unmodified by that recovery
