## MODIFIED Requirements

### Requirement: FRG runbook and supervisor ship text SHALL document already-integrated freeze and the pack-loop profile

The Factory Reliability Gate runbook and supervisor ship documentation SHALL document (1) that `pipeline ship --milestone` on an all-integrated freeze-eligible set (every freeze-eligible issue closed at `pipeline:ready-to-deploy` with merged contained PRs) proceeds past train freeze and records `already-integrated`, (2) that freeze-eligible integration is not authorization to start Factory Reliability Gate (FRG) pack, release, or promote while any GitHub issue on that milestone remains open, (3) that the ship-end remaining-open check re-observes GitHub immediately before those post-train operations and fails closed naming the milestone and every remaining open issue number, and (4) that a missing FRG pass is recovered by running the `factory-gate` pack loop on a native-`/goal` engine (`--profile claude`) and then `pipeline factory-gate --for <version> --from-run <loop-run-id>`. The docs SHALL NOT present `--skip-frg` as the default or implied path for a non-claude profile. The docs SHALL NOT present `--skip-frg` as a way to start FRG, release, or promote while the milestone still has open issues.

#### Scenario: Runbook names already-integrated ship freeze

- **WHEN** an operator reads `docs/factory-reliability-gate-runbook.md` after this change
- **THEN** the runbook SHALL state that an all-integrated freeze-eligible set does not stop at `no open issues to freeze`
- **AND** SHALL state that those items are recorded `already-integrated` before the remaining-open check
- **AND** SHALL NOT state that freeze-eligible integration by itself starts the FRG / release phase

#### Scenario: Runbook names remaining-open ship-end gate

- **WHEN** an operator reads the FRG runbook or supervisor ship text after this change
- **THEN** the text SHALL state that leftover open GitHub issues on the ship milestone, including `pipeline:backlog`, fail closed before FRG pack, release, and promote
- **AND** SHALL state that pipeline labels do not exempt an open milestoned issue

#### Scenario: Runbook and supervisor name pack-loop profile

- **WHEN** an operator reads the FRG runbook or supervisor ship text after this change
- **THEN** the text SHALL name `pipeline loop --label factory-gate --profile claude`
- **AND** SHALL name `pipeline factory-gate --for <version> --from-run <loop-run-id>`
- **AND** SHALL NOT present `--skip-frg` as the default recovery
