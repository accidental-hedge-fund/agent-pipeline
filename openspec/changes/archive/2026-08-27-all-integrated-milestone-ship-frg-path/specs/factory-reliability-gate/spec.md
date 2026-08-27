## ADDED Requirements

### Requirement: Missing FRG evidence diagnostics SHALL name the pack-loop command and native-goal profile

When Factory Reliability Gate (FRG) evidence is missing, unparsable, or otherwise not release-eligible, `pipeline release`, in-engine `pipeline ship`, and `pipeline factory-gate` (including missing-`--from-run` usage) SHALL name the exact next operator commands required to produce a release-eligible pass. Those commands SHALL include (1) the durable pack loop with a native-`/goal` engine profile, using `pipeline loop --label factory-gate --profile claude` (or an equivalent documented native-`/goal` profile), and (2) the scorer `pipeline factory-gate --for <version> --from-run <loop-run-id>`. Naming only `pipeline factory-gate --for <version>` SHALL NOT satisfy this requirement. Durable `factory-release prepare` MAY appear as an additional line. This requirement SHALL NOT auto-run the pack loop inside ship or release, SHALL NOT change native-`/goal` attestation defaults, and SHALL NOT treat unit CI success as an FRG pass.

#### Scenario: Release missing-pass names loop, profile, and from-run

- **WHEN** `pipeline release <X.Y.Z>` fails closed because `.agent-pipeline/frg/<X.Y.Z>/latest.json` is missing
- **THEN** the failure text SHALL contain `pipeline loop --label factory-gate --profile claude`
- **AND** it SHALL contain `pipeline factory-gate --for <X.Y.Z> --from-run`
- **AND** it SHALL NOT consist only of `Run: pipeline factory-gate --for <X.Y.Z>`

#### Scenario: Factory-gate missing from-run names loop and profile

- **WHEN** an operator runs `pipeline factory-gate --for <X.Y.Z>` without `--from-run`
- **THEN** the usage / failure text SHALL contain `pipeline loop --label factory-gate --profile claude`
- **AND** it SHALL contain `pipeline factory-gate --for <X.Y.Z> --from-run`

#### Scenario: Ship missing FRG names the same runnable path

- **WHEN** in-engine `pipeline ship` fails closed because FRG evidence for the shipment version is missing or not release-eligible
- **THEN** the failure text SHALL contain `pipeline loop --label factory-gate --profile claude`
- **AND** it SHALL contain `pipeline factory-gate --for <version> --from-run`

### Requirement: Missing FRG diagnostics SHALL NOT present skip-frg as the implied recovery

Missing-FRG failure text on `pipeline release`, `pipeline ship`, and `pipeline factory-gate` SHALL NOT present `--skip-frg` as the only next command and SHALL NOT imply `--skip-frg` as the recovery for a non-claude active profile. `--skip-frg` MAY appear as a last-line documented escape. A skip pin SHALL remain a non-production `no-frg-*` marker. Default release and ship SHALL still require a recorded FRG pass.

#### Scenario: Skip is not the only named recovery

- **WHEN** `pipeline release <X.Y.Z>` fails closed because FRG evidence is missing
- **THEN** the failure text SHALL name the pack-loop command and `--from-run` scorer
- **AND** if `--skip-frg` appears, it SHALL NOT be the first or only named recovery
- **AND** the text SHALL NOT tell a non-claude profile that skip is how that profile ships

#### Scenario: Skip escape remains non-production

- **WHEN** an operator uses `pipeline release --skip-frg` (or the equivalent documented escape)
- **THEN** the resulting pin SHALL remain a non-production `no-frg-*` marker
- **AND** it SHALL NOT satisfy a production-quality FRG pin

### Requirement: FRG runbook and supervisor ship text SHALL document already-integrated freeze and the pack-loop profile

The Factory Reliability Gate runbook and supervisor ship documentation SHALL document (1) that `pipeline ship --milestone` on an all-integrated milestone (every freeze-eligible issue closed at `pipeline:ready-to-deploy` with merged contained PRs) proceeds past train freeze and records `already-integrated`, and (2) that a missing FRG pass is recovered by running the `factory-gate` pack loop on a native-`/goal` engine (`--profile claude`) and then `pipeline factory-gate --for <version> --from-run <loop-run-id>`. The docs SHALL NOT present `--skip-frg` as the default or implied path for a non-claude profile.

#### Scenario: Runbook names already-integrated ship freeze

- **WHEN** an operator reads `docs/factory-reliability-gate-runbook.md` after this change
- **THEN** the runbook SHALL state that an all-integrated milestone does not stop at `no open issues to freeze`
- **AND** SHALL state that those items are recorded `already-integrated` before the FRG / release phase

#### Scenario: Runbook and supervisor name pack-loop profile

- **WHEN** an operator reads the FRG runbook or supervisor ship text after this change
- **THEN** the text SHALL name `pipeline loop --label factory-gate --profile claude`
- **AND** SHALL name `pipeline factory-gate --for <version> --from-run <loop-run-id>`
- **AND** SHALL NOT present `--skip-frg` as the default recovery

### Requirement: Missing-FRG diagnostic regressions SHALL be guarded by automated tests

The test suite SHALL fail if a missing-FRG diagnostic for `pipeline release`, `pipeline ship`, or `pipeline factory-gate` omits the pack-loop command or the native-`/goal` profile (`--profile claude`). The suite SHALL fail if that diagnostic names only `pipeline factory-gate --for <version>` as the next command. These tests SHALL inject deps and SHALL perform zero real network, git, or subprocess calls.

#### Scenario: Scorer-only release diagnostic fails CI

- **WHEN** a hermetic fixture exercises `requireFrgPassForRelease` (or the release missing-pass path) with no FRG artifact
- **AND** the diagnostic omits `pipeline loop --label factory-gate --profile claude` or omits `--from-run`
- **THEN** the test SHALL fail under the unit suite consumed by `npm run ci`

#### Scenario: Factory-gate usage omission fails CI

- **WHEN** a hermetic fixture exercises `pipeline factory-gate --for <version>` without `--from-run`
- **AND** the usage / failure text omits `--profile claude` or the pack-loop command
- **THEN** the test SHALL fail
