## MODIFIED Requirements

### Requirement: The advance loop SHALL never invoke merge-queue and no auto_merge config key SHALL exist
The merge-queue handler SHALL NOT be called from any stage handler, the advance loop, or any path reachable from `pipeline advance`. The pipeline configuration schema and documented config keys SHALL NOT introduce an `auto_merge` key that enables autonomous merging. Human-owned merge authority remains: only explicit operator invocation of `pipeline merge` or `pipeline merge-queue --apply` (dry-run is the merge-queue default) may merge. Session-bound operator authority for a given invocation is the only merge path; unattended merge remains out of scope for this surface.

#### Scenario: No stage transition calls merge-queue
- **WHEN** the advance loop dispatches any stage (planning through deploy-ready)
- **THEN** no call to the merge-queue plan/drive handler occurs

#### Scenario: Isolation test asserts advance does not import merge-queue
- **WHEN** the loop-isolation unit test for merge-queue runs
- **THEN** it SHALL assert that advance stage handlers and the advance loop do
  not import or reference merge-queue module symbols used for planning or drive

#### Scenario: No auto_merge config key is added
- **WHEN** pipeline configuration documentation and schema for this change are
  inspected
- **THEN** they SHALL NOT define an `auto_merge` config key that enables
  autonomous merging of ready-to-deploy PRs

#### Scenario: Explicit merge-queue apply is operator-owned not advance-owned
- **WHEN** an operator runs `pipeline merge-queue --milestone <m> --apply`
- **THEN** the command MAY merge eligible ready-to-deploy candidates under merge-queue gates
- **AND** that apply path SHALL remain unreachable from `pipeline advance`
