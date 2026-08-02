## MODIFIED Requirements

### Requirement: Mechanical remediation SHALL re-enter the normal whole-item pipeline

The `repair_pipeline_item` recovery executor SHALL receive the exact stage diagnostic and
authoritative candidate identity. It SHALL resolve the current stage, configured implementer
adapter, model, effort, and permissions; reconcile and, when safe, rematerialize the managed
worktree; invoke one shared bounded mechanical-remediation transaction; validate, commit, and push
a successful repair; and return success or exact failure evidence. The next normal whole-item
dispatch SHALL re-run all applicable review, CI, OpenSpec, pre-merge, and readiness gates. The
supervisor SHALL NOT branch on stage name, OpenSpec, finding category, or harness name.

The substantive implementer work inside that remediation transaction SHALL use the shared
harness-round helper either directly or via the pre-merge bounded auto-fix path that itself uses
the shared helper. Recovery-shell logic unique to attempt identity — durable pre-invocation
breadcrumb, ownership proof before adopting unpushed commits, idempotent reconciliation of
already-pushed marked repairs, and refusal to adopt unrelated human commits — MAY remain local to
`repair_pipeline_item` as a documented narrow exemption from calling the shared helper for the
shell itself. That exemption SHALL NOT reintroduce a private full implementer-round skeleton for
the substantive path.

#### Scenario: Repair uses the configured implementer coordinate

- **WHEN** `repair_pipeline_item` is claimed for a repository configured with any registered
  implementer adapter and supported model/effort coordinate
- **THEN** the per-item pipeline SHALL invoke that resolved coordinate through the adapter contract
- **AND** the supervisor SHALL remain unaware of the provider and model values

#### Scenario: Repair cannot bypass gates

- **WHEN** a mechanical repair creates and pushes a commit
- **THEN** the item SHALL re-enter normal execution against the new head
- **AND** it SHALL not become ready-to-deploy until all normal review and deterministic gates pass

#### Scenario: Substantive repair uses the shared harness-round stack

- **WHEN** `repair_pipeline_item` performs a substantive implementer repair
- **THEN** the implementer invoke/salvage/commit skeleton SHALL run through the shared harness-round
  helper or the shared-helper-backed auto-fix path
- **AND** the recovery shell MAY still own breadcrumb write/delete and post-crash reconciliation

#### Scenario: Recovery shell refuses unmarked human commits

- **WHEN** an unpushed commit exists on the claimed head without the attempt's ownership proof
  (breadcrumb/marker)
- **THEN** `repair_pipeline_item` SHALL refuse to amend, push, or adopt that commit as a repair
- **AND** SHALL return failure evidence rather than publishing unowned work
