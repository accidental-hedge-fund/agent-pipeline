## MODIFIED Requirements

### Requirement: Never auto-merge (structural guarantee)
The pipeline SHALL NOT merge pull requests from the autonomous `advance` loop or from any stage handler reachable from `pipeline advance`. There is no merge stage in `STAGES`; the terminal stage is `ready-to-deploy`. No call to `mergePr`, the `pipeline merge` handler, or the `merge-queue` plan/drive path SHALL be reachable from `pipeline advance` or from stage transitions the advance loop dispatches. The `auto_merge` config key SHALL be absent from `PartialConfigSchema`; a repo that sets it SHALL receive a strict-schema parse error identifying `auto_merge` as an unknown key (see `pipeline-configuration`). The never-autonomous-merge guarantee is structural — enforced by stage layout, advance dispatch isolation, and config parse rejection, not by a runtime "auto merge" switch.

Operator-invoked merge surfaces exist as separate, loop-isolated CLI commands. Explicit operator invocation of `pipeline merge <pr>` and of `pipeline merge-queue` with `--apply` (dry-run is the default for merge-queue) MAY merge ready-to-deploy pull requests under those commands' own safety gates. Those surfaces are never called by the advance loop and do not weaken the structural never-autonomous-merge guarantee; they are the controlled, session-bound mechanism by which an operator (or pipeline-desk on an operator button click) performs a merge after the pipeline reaches `ready-to-deploy`. See the `merge-sub-command` and `merge-queue-command` capabilities for their requirements. Unattended merge without an explicit operator invocation for that session is out of scope for this guarantee and remains a separate product decision (tracked elsewhere).

#### Scenario: auto_merge key is rejected at config parse time
- **WHEN** a repo sets `auto_merge: true` in `.github/pipeline.yml`
- **THEN** `resolveConfig()` SHALL throw with a parse error identifying `auto_merge` as an unknown key
- **AND** the pipeline SHALL NOT run

#### Scenario: advance loop never invokes the merge handler
- **WHEN** the advance loop dispatches any stage transition (from `ready` through `ready-to-deploy`)
- **THEN** no call to the `pipeline merge` handler, `mergePr`, or any merge-queue plan/drive handler is made
- **AND** the loop terminates at `ready-to-deploy` without merging the PR

#### Scenario: no merge stage in STAGES
- **WHEN** the canonical `STAGES` ordered list is inspected
- **THEN** it SHALL NOT contain a merge stage
- **AND** the final stage SHALL be `ready-to-deploy`

#### Scenario: operator merge surfaces remain loop-isolated
- **WHEN** an operator runs `pipeline merge <pr>` or `pipeline merge-queue … --apply` after an issue is at `pipeline:ready-to-deploy`
- **THEN** those commands MAY merge under their own gates
- **AND** neither command SHALL be invoked by the advance loop as part of ordinary stage progression
