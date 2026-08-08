## MODIFIED Requirements

### Requirement: Never auto-merge (structural guarantee)

The Pipeline autonomous `advance` loop and every stage handler reachable from `pipeline advance` SHALL NOT merge pull requests. There is no merge stage in `STAGES`; the terminal happy-path stage is `ready-to-deploy`. No call to `mergePr`, the `pipeline merge` handler, or the merge-queue plan/drive path SHALL be reachable from `pipeline advance` or from stage transitions that the advance loop dispatches. The `auto_merge` config key SHALL be absent from `PartialConfigSchema`; a repository that sets it SHALL receive a strict-schema parse error that identifies `auto_merge` as an unknown key. This advance-loop guarantee is structural and is not controlled by a runtime switch.

Loop-isolated merge surfaces exist separately. A direct operator MAY invoke `pipeline merge <pr>` or `pipeline merge-queue ... --apply` under those commands' gates. A disabled-by-default external factory wrapper MAY invoke `pipeline merge <pr>` after it validates an authenticated, immutable, expiring operator grant for the exact action. That wrapper SHALL remain outside stage dispatch and repository configuration. Its use does not add a merge stage and does not let ordinary `advance` or `loop` merge.

#### Scenario: auto_merge key is rejected at config parse time

- **WHEN** a repository sets `auto_merge: true` in `.github/pipeline.yml`
- **THEN** `resolveConfig()` SHALL throw with a parse error that identifies `auto_merge` as an unknown key
- **AND** Pipeline SHALL NOT run

#### Scenario: advance loop never invokes the merge handler

- **WHEN** the advance loop dispatches any stage transition from `ready` through `ready-to-deploy`
- **THEN** it SHALL make no call to `pipeline merge`, `mergePr`, or a merge-queue plan/drive handler
- **AND** it SHALL terminate at `ready-to-deploy` without merging the pull request

#### Scenario: no merge stage exists

- **WHEN** the canonical `STAGES` list is inspected
- **THEN** it SHALL NOT contain a merge stage
- **AND** the happy-path terminal stage SHALL be `ready-to-deploy`

#### Scenario: operator-authorized merge surfaces remain loop-isolated

- **WHEN** a direct operator or a deployment wrapper with a valid exact grant invokes `pipeline merge <pr>` after an issue is at `pipeline:ready-to-deploy`
- **THEN** that command MAY merge under its own gates
- **AND** it SHALL NOT be invoked by the advance loop as part of ordinary stage progression
