## ADDED Requirements

### Requirement: Doctor SHALL check run-store write path and recent write-health

The doctor preflight check set SHALL include a deterministic **run-store write-health** check that
does not invoke a language model. The check SHALL fail when either (1) the resolved repository's
run-store parent path (`.agent-pipeline/runs` under the repo root, when resolvable) is not writable,
or (2) a bounded scan of recent run directories finds elevated write-health (one or more recorded
append failures). On failure the check SHALL print remediation text that names the problem (disk
permissions, full filesystem, exclusive sink loss, or incomplete evidence) and instructs the
operator how to investigate. A failing check SHALL cause `pipeline doctor` to exit non-zero in
accordance with the existing doctor pass/fail contract. When the run-store path cannot be resolved
and no recent runs are available, the check SHALL pass or skip without inventing failures.

#### Scenario: Unwritable run-store path fails doctor

- **WHEN** `pipeline doctor` runs and the resolved `.agent-pipeline/runs` parent path is not
  writable
- **THEN** the run-store write-health check SHALL fail
- **AND** remediation text SHALL mention permissions or disk space
- **AND** doctor SHALL exit with code 1 when any check fails

#### Scenario: Recent elevated write-health fails doctor

- **WHEN** `pipeline doctor` runs and a bounded recent run directory has elevated write-health
- **THEN** the run-store write-health check SHALL fail
- **AND** remediation text SHALL mention incomplete event evidence or sink/local write failure
- **AND** doctor SHALL exit with code 1 when any check fails

#### Scenario: Healthy recent runs pass the check

- **WHEN** `pipeline doctor` runs and the run-store path is writable
- **AND** the bounded recent scan finds no elevated write-health
- **THEN** the run-store write-health check SHALL pass
- **AND** it SHALL NOT cause doctor to fail solely for this reason
